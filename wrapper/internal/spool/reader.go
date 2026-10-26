package spool

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// maxLineBytes bounds one journal line. Artifact bodies live in blobs/, so a
// legitimate record is small; xyz geometries and inline artifact previews are
// the largest payloads (≤ a few MB).
const maxLineBytes = 64 << 20

// TailError describes damage at the end of a journal (torn write, crash
// mid-append, truncation). The records before it are intact and replayable;
// per the no-silent-drops rule, sync must surface this to the operator
// instead of pretending the journal ended cleanly.
type TailError struct {
	Line   int    // 1-based line number of the first damaged record
	Reason string // what was wrong with it
}

func (e *TailError) Error() string {
	return fmt.Sprintf("journal damaged at line %d: %s (records before it are intact and will sync; anything after is lost)", e.Line, e.Reason)
}

// Journal is one journal read back from disk.
type Journal struct {
	Dir    string
	Header Header
	Ops    []Record
	// Tail is non-nil when the journal's tail was damaged; Ops then holds
	// the valid prefix.
	Tail *TailError
}

// JournalPath returns the journal file inside dir.
func JournalPath(dir string) string { return filepath.Join(dir, journalFileName) }

// Load reads a journal directory. It fails hard on a missing/unreadable
// file, a bad header, or a format newer than this binary understands; tail
// damage in the op lines is tolerated and reported via Journal.Tail.
func Load(dir string) (*Journal, error) {
	path := JournalPath(dir)
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open journal: %w", err)
	}
	defer func() {
		if cerr := f.Close(); cerr != nil {
			// Read-only close after a full read loses nothing; note it anyway.
			fmt.Fprintf(os.Stderr, "[dftstream] warning: closing journal %s: %v\n", path, cerr) //nolint:errcheck — write to stderr is best-effort
		}
	}()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), maxLineBytes)

	// Header: the first line must parse. If it doesn't, the file is not a
	// journal (or its very first write was torn) — nothing is replayable.
	if !sc.Scan() {
		if err := sc.Err(); err != nil {
			return nil, fmt.Errorf("read journal header: %w", err)
		}
		return nil, fmt.Errorf("journal %s is empty", path)
	}
	var hdr Header
	if err := json.Unmarshal(sc.Bytes(), &hdr); err != nil {
		return nil, fmt.Errorf("journal %s has an unreadable header: %w", path, err)
	}
	if (hdr.Format != FormatName && hdr.Format != legacyFormatName) || hdr.Kind != kindHeader {
		return nil, fmt.Errorf("%s is not a dftstream spool journal (format %q)", path, hdr.Format)
	}
	if hdr.Version > FormatVersion {
		return nil, fmt.Errorf("journal %s uses format v%d but this dftstream understands up to v%d. Fix: upgrade dftstream on this host and re-run sync", path, hdr.Version, FormatVersion)
	}
	if hdr.JournalID == "" {
		return nil, fmt.Errorf("journal %s header carries no journalId", path)
	}

	j := &Journal{Dir: dir, Header: hdr}
	lineNo := 1
	var wantSeq int64 = 1
	for sc.Scan() {
		lineNo++
		line := sc.Bytes()
		if len(bytes.TrimSpace(line)) == 0 {
			// A blank line can only come from tampering; everything after is
			// suspect.
			j.Tail = &TailError{Line: lineNo, Reason: "blank line in op log"}
			return j, nil
		}
		var rec Record
		if err := json.Unmarshal(line, &rec); err != nil {
			j.Tail = &TailError{Line: lineNo, Reason: fmt.Sprintf("unparsable record: %v", err)}
			return j, nil
		}
		if rec.Kind != kindOp {
			j.Tail = &TailError{Line: lineNo, Reason: fmt.Sprintf("unexpected record kind %q", rec.Kind)}
			return j, nil
		}
		if rec.Seq != wantSeq {
			j.Tail = &TailError{Line: lineNo, Reason: fmt.Sprintf("sequence gap: got seq %d, want %d", rec.Seq, wantSeq)}
			return j, nil
		}
		if rec.Key != fmt.Sprintf("%s:%d", hdr.JournalID, rec.Seq) {
			j.Tail = &TailError{Line: lineNo, Reason: fmt.Sprintf("record key %q does not match journal %s", rec.Key, hdr.JournalID)}
			return j, nil
		}
		j.Ops = append(j.Ops, rec)
		wantSeq++
	}
	if err := sc.Err(); err != nil {
		// bufio reports a final line without trailing newline as a normal
		// token, so an error here is either an oversized line or a read
		// failure. Both damage only the tail.
		j.Tail = &TailError{Line: lineNo + 1, Reason: err.Error()}
		return j, nil
	}
	return j, nil
}

// LoadBlob reads and verifies an artifact body referenced by a record.
// A digest or size mismatch is corruption: better no upload than a silently
// wrong scientific file.
func (j *Journal) LoadBlob(ref BlobRef) ([]byte, error) {
	rel := filepath.Clean(ref.File)
	if filepath.IsAbs(rel) || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return nil, fmt.Errorf("blob reference %q escapes the journal directory", ref.File)
	}
	body, err := os.ReadFile(filepath.Join(j.Dir, rel))
	if err != nil {
		return nil, fmt.Errorf("read blob %s: %w", ref.File, err)
	}
	if int64(len(body)) != ref.Size {
		return nil, fmt.Errorf("blob %s is %d bytes, journal recorded %d — refusing to upload a corrupt artifact", ref.File, len(body), ref.Size)
	}
	sum := sha256.Sum256(body)
	if got := hex.EncodeToString(sum[:]); got != ref.SHA256 {
		return nil, fmt.Errorf("blob %s digest mismatch (got %s, journal recorded %s) — refusing to upload a corrupt artifact", ref.File, got, ref.SHA256)
	}
	return body, nil
}
