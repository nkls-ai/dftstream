package spool

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

// WriterConfig describes the journal a Writer creates.
type WriterConfig struct {
	// Root is the spool root; empty means DefaultRoot().
	Root string
	// RunName / ExperimentName / Hostname / DFTStreamVersion annotate the
	// header (RunName also names the journal directory).
	RunName          string
	ExperimentName   string
	Hostname         string
	DFTStreamVersion string
	// Mode is why the journal is being written (see Header.Mode).
	Mode Mode
}

// Writer appends op records to a journal. Safe for concurrent use: tracker
// calls arrive from the batch flush goroutine, the sysinfo sampler and the
// finalize path at once.
type Writer struct {
	mu        sync.Mutex
	dir       string
	journalID string
	f         *os.File
	seq       int64
	// localSeq / blobSeq are independent counters for journal-local entity
	// IDs and blob file names, so concurrent allocations can never collide.
	localSeq int64
	blobSeq  int64
	closed   bool
	// dirty is set by Append and cleared by Sync, so Close knows whether an
	// fsync is still owed.
	dirty bool
}

// NewWriter creates the journal directory, writes and fsyncs the header, and
// returns a Writer ready for Append.
func NewWriter(cfg WriterConfig) (*Writer, error) {
	root := cfg.Root
	if root == "" {
		var err error
		root, err = DefaultRoot()
		if err != nil {
			return nil, err
		}
	}
	id, err := newJournalID()
	if err != nil {
		return nil, err
	}
	dir := filepath.Join(root, fmt.Sprintf("%d-%s-%s",
		time.Now().UnixMilli(), sanitizeName(cfg.RunName), id[:8]))
	if err := os.MkdirAll(filepath.Join(dir, blobsDirName), 0o700); err != nil {
		return nil, fmt.Errorf("create journal directory: %w", err)
	}
	f, err := os.OpenFile(filepath.Join(dir, journalFileName),
		os.O_CREATE|os.O_EXCL|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, fmt.Errorf("create journal file: %w", err)
	}
	w := &Writer{dir: dir, journalID: id, f: f}
	header := Header{
		Version:          FormatVersion,
		Kind:             kindHeader,
		Format:           FormatName,
		JournalID:        id,
		CreatedAt:        time.Now(),
		RunName:          cfg.RunName,
		ExperimentName:   cfg.ExperimentName,
		Hostname:         cfg.Hostname,
		DFTStreamVersion: cfg.DFTStreamVersion,
		Mode:             cfg.Mode,
	}
	line, err := marshalLine(header)
	if err != nil {
		w.abandon()
		return nil, fmt.Errorf("encode journal header: %w", err)
	}
	if _, err := f.Write(line); err != nil {
		w.abandon()
		return nil, fmt.Errorf("write journal header: %w", err)
	}
	// The header is the file's identity; make it durable before any op can
	// reference the journal.
	if err := f.Sync(); err != nil {
		w.abandon()
		return nil, fmt.Errorf("sync journal header: %w", err)
	}
	return w, nil
}

// abandon closes and removes a half-created journal so a failed NewWriter
// leaves nothing behind for sync to trip over.
func (w *Writer) abandon() {
	if err := w.f.Close(); err != nil {
		fmt.Fprintf(os.Stderr, "[dftstream] warning: closing abandoned journal: %v\n", err) //nolint:errcheck — write to stderr is best-effort
	}
	if err := os.RemoveAll(w.dir); err != nil {
		fmt.Fprintf(os.Stderr, "[dftstream] warning: removing abandoned journal %s: %v\n", w.dir, err) //nolint:errcheck — write to stderr is best-effort
	}
}

// Dir returns the journal directory (for user-facing messages).
func (w *Writer) Dir() string { return w.dir }

// Append writes one op record. Each record is written as a single write(2)
// of one line; fsync is deferred to Sync/Close (an op lost to a crash before
// the final fsync is no worse than one that was never journaled, but a
// torn/interleaved line would poison the tail for everything after it).
func (w *Writer) Append(op OpKind, p Payload) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return fmt.Errorf("journal %s is closed; dropped %s op", w.dir, op)
	}
	w.seq++
	rec := Record{
		Version: FormatVersion,
		Kind:    kindOp,
		Seq:     w.seq,
		Key:     w.journalID + ":" + strconv.FormatInt(w.seq, 10),
		TS:      time.Now(),
		Op:      op,
		Payload: p,
	}
	line, err := marshalLine(rec)
	if err != nil {
		w.seq-- // the record was never written; keep seq contiguous
		return fmt.Errorf("encode journal record (%s): %w", op, err)
	}
	if _, err := w.f.Write(line); err != nil {
		return fmt.Errorf("append to journal %s: %w", w.dir, err)
	}
	w.dirty = true
	return nil
}

// nextLocalID allocates a journal-local entity ID ("spool-<kind>-<n>"),
// unique within the journal.
func (w *Writer) nextLocalID(kind string) string {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.localSeq++
	return localIDPrefix + kind + "-" + strconv.FormatInt(w.localSeq, 10)
}

// WriteBlob stores an artifact body under blobs/ and returns its reference.
// The file is fsynced: blob bytes referenced by a durable journal record must
// not themselves be allowed to vanish in a crash.
func (w *Writer) WriteBlob(name string, body []byte) (BlobRef, error) {
	w.mu.Lock()
	w.blobSeq++
	seq := w.blobSeq
	w.mu.Unlock()
	rel := filepath.Join(blobsDirName, fmt.Sprintf("%06d-%s", seq, sanitizeName(name)))
	path := filepath.Join(w.dir, rel)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return BlobRef{}, fmt.Errorf("create blob %s: %w", rel, err)
	}
	if _, err := f.Write(body); err != nil {
		if cerr := f.Close(); cerr != nil {
			return BlobRef{}, fmt.Errorf("write blob %s: %w (and close: %v)", rel, err, cerr)
		}
		return BlobRef{}, fmt.Errorf("write blob %s: %w", rel, err)
	}
	if err := f.Sync(); err != nil {
		if cerr := f.Close(); cerr != nil {
			return BlobRef{}, fmt.Errorf("sync blob %s: %w (and close: %v)", rel, err, cerr)
		}
		return BlobRef{}, fmt.Errorf("sync blob %s: %w", rel, err)
	}
	if err := f.Close(); err != nil {
		return BlobRef{}, fmt.Errorf("close blob %s: %w", rel, err)
	}
	sum := sha256.Sum256(body)
	return BlobRef{File: rel, Size: int64(len(body)), SHA256: hex.EncodeToString(sum[:])}, nil
}

// Sync flushes the journal to stable storage.
func (w *Writer) Sync() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed || !w.dirty {
		return nil
	}
	if err := w.f.Sync(); err != nil {
		return fmt.Errorf("sync journal %s: %w", w.dir, err)
	}
	w.dirty = false
	return nil
}

// Count returns the number of op records written so far.
func (w *Writer) Count() int64 {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.seq
}

// Close fsyncs and closes the journal. Called at run end; after Close every
// journaled op is durable.
func (w *Writer) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return nil
	}
	w.closed = true
	syncErr := w.f.Sync()
	closeErr := w.f.Close()
	if syncErr != nil {
		return fmt.Errorf("sync journal %s at close: %w", w.dir, syncErr)
	}
	if closeErr != nil {
		return fmt.Errorf("close journal %s: %w", w.dir, closeErr)
	}
	return nil
}
