// Package spool implements offline journaling for firewalled compute nodes.
//
// Most clusters block outbound traffic from compute nodes; only login nodes
// reach the tracking backend. When the backend is unreachable (or the
// operator asked for --offline up front), every tracker operation of a run is
// appended to a local journal instead of being dropped. `dftstream sync`,
// run later from a login node, replays the journal to the backend —
// idempotently, in order, resumable after interruption.
//
// # On-disk layout
//
// One directory per journaled run, under the spool root
// ($DFTSTREAM_SPOOL_DIR, defaulting to
// ${XDG_STATE_HOME:-$HOME/.local/state}/dftstream/spool — deliberately in
// the home filesystem, which clusters share between compute and login nodes,
// and never inside the chemist's run directory):
//
//	<root>/<created-ms>-<run-name>-<id>/
//	    journal.jsonl   append-only op log (this file is the journal)
//	    blobs/          artifact bodies, referenced from journal records
//	    cursor.json     sync progress sidecar, written only by `dftstream sync`
//
// # Journal format (version 1)
//
// journal.jsonl is JSON Lines. The first line is a header record
// (kind "header"); every following line is one op record (kind "op") with a
// monotonically increasing seq, a client-generated idempotency key
// ("<journalId>:<seq>"), a wall-clock timestamp, a typed op name and a typed
// payload. Records are self-describing: a reader needs nothing but this file
// (plus blobs/ for artifact bodies) to replay the run. The format version is
// carried in every record; see docs/COMPAT.md for the versioning policy.
//
// A corrupt or truncated tail (power loss mid-append) must never poison the
// run: the reader returns every valid record before the damage plus a
// TailError describing it, and sync replays the valid prefix while reporting
// the loss — per the repo rule that an error is never silently dropped.
package spool

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/nkls-ai/dftstream/internal/artifacts"
	"github.com/nkls-ai/dftstream/internal/tracker"
)

// FormatVersion is the journal format written by this binary. Bumped
// whenever a record or payload shape changes such that an older
// `dftstream sync` could misread it; sync refuses journals from a NEWER
// format with a "upgrade dftstream" message rather than guessing.
const FormatVersion = 1

// FormatName identifies the file type in the header (a reader's sanity
// check that it is not being pointed at some other JSONL file).
const FormatName = "dftstream-spool"

// legacyFormatName is FormatName as written before the project was renamed
// from OrcaStream. The record layout is the same, so those journals still sync.
const legacyFormatName = "orcastream-spool"

// journalFileName is the op log inside a journal directory.
const journalFileName = "journal.jsonl"

// blobsDirName holds artifact bodies referenced from journal records.
const blobsDirName = "blobs"

// cursorFileName is the sync-progress sidecar (see replay.go). The journal
// itself is never rewritten; progress lives here.
const cursorFileName = "cursor.json"

// SyncedDirSuffix marks a fully-synced journal directory kept with --keep.
// The default scan skips these.
const SyncedDirSuffix = ".synced"

// OpKind names one journaled tracker operation. Typed, not free-form: the
// writer only emits these and the replayer switches over them, so an unknown
// kind in a journal is either corruption or a newer format.
type OpKind string

const (
	OpEnsureExperiment OpKind = "ensure_experiment"
	OpEnsureBatch      OpKind = "ensure_batch"
	OpCreateRun        OpKind = "create_run"
	OpUpdateStatus     OpKind = "update_status"
	OpAppendEvents     OpKind = "append_events"
	OpAppendMetrics    OpKind = "append_metrics"
	OpAppendSysSamples OpKind = "append_sys_samples"
	OpAppendLogs       OpKind = "append_logs"
	OpAppendGeometry   OpKind = "append_geometry"
	OpSetFrequencies   OpKind = "set_frequencies"
	OpSetExcitedStates OpKind = "set_excited_states"
	OpSetNMRShields    OpKind = "set_nmr_shields"
	OpSetArtifacts     OpKind = "set_artifacts"
	OpAppendArtifacts  OpKind = "append_artifacts"
	OpUpsertArtifacts  OpKind = "upsert_artifacts"
)

// recordKind distinguishes the header line from op lines.
type recordKind string

const (
	kindHeader recordKind = "header"
	kindOp     recordKind = "op"
)

// Header is the first line of every journal.
type Header struct {
	Version int        `json:"v"`
	Kind    recordKind `json:"kind"`
	Format  string     `json:"format"`
	// JournalID is the random identity of this journal; op idempotency keys
	// are derived from it, which is what makes a re-replayed record
	// recognizable server-side.
	JournalID string    `json:"journalId"`
	CreatedAt time.Time `json:"createdAt"`
	// Context for humans and the sync summary; replay does not depend on it.
	RunName          string `json:"runName,omitempty"`
	ExperimentName   string `json:"experimentName,omitempty"`
	Hostname         string `json:"hostname,omitempty"`
	DFTStreamVersion string `json:"dftstreamVersion,omitempty"`
	// Mode records why this journal exists: "offline" (explicit --offline /
	// DFTSTREAM_OFFLINE=1) or "failover" (backend became unreachable
	// mid-command).
	Mode Mode `json:"mode,omitempty"`
}

// Record is one op line of the journal.
type Record struct {
	Version int        `json:"v"`
	Kind    recordKind `json:"kind"`
	// Seq is 1-based and strictly increasing; a gap means a damaged file.
	Seq int64 `json:"seq"`
	// Key is the op's idempotency key ("<journalId>:<seq>"), sent to the
	// backend's guarded mutations on replay.
	Key     string    `json:"key"`
	TS      time.Time `json:"ts"`
	Op      OpKind    `json:"op"`
	Payload Payload   `json:"payload"`
}

// BlobRef points an artifact payload at its body in blobs/. The digest is
// verified on replay: uploading silently corrupted scientific data is worse
// than failing the sync.
type BlobRef struct {
	// File is the path relative to the journal directory.
	File   string `json:"file"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

// ArtifactRec is a tracker.Artifact with the in-memory Body replaced by a
// BlobRef — bodies can be hundreds of megabytes and do not belong inside a
// JSON line.
type ArtifactRec struct {
	Name        string         `json:"name"`
	Path        string         `json:"path"`
	Kind        artifacts.Kind `json:"kind"`
	SizeBytes   int64          `json:"sizeBytes"`
	MTime       time.Time      `json:"mtime"`
	ContentText string         `json:"contentText,omitempty"`
	Truncated   bool           `json:"truncated,omitempty"`
	Blob        *BlobRef       `json:"blob,omitempty"`
}

// Payload carries the arguments of one op. Exactly the fields relevant to
// the record's OpKind are set; the tracker structs are embedded directly (the
// journal format is versioned with the wrapper, see docs/COMPAT.md), except
// artifacts, whose bodies are externalized to blobs.
type Payload struct {
	// Identifiers. A local ID (spool-…) names an entity that only exists in
	// this journal; replay maps it to the backend ID the corresponding
	// ensure/create op returns. A non-local ID passed through unchanged means
	// the entity was created live before the failover.
	OrgID        string `json:"orgId,omitempty"`
	ExperimentID string `json:"experimentId,omitempty"`
	BatchID      string `json:"batchId,omitempty"`
	RunID        string `json:"runId,omitempty"`
	// LocalID is the journal-local ID assigned by the ensure/create op the
	// record describes.
	LocalID string `json:"localId,omitempty"`

	Name          string `json:"name,omitempty"`
	ArtifactLevel string `json:"artifactLevel,omitempty"` // levels.ArtifactLevel.String() spelling

	Run    *tracker.RunCreate    `json:"run,omitempty"`
	Status *tracker.StatusUpdate `json:"status,omitempty"`

	Events     []tracker.Event        `json:"events,omitempty"`
	Metrics    []tracker.Metric       `json:"metrics,omitempty"`
	SysSamples []tracker.SysSample    `json:"sysSamples,omitempty"`
	Logs       []tracker.LogEntry     `json:"logs,omitempty"`
	Freqs      []tracker.Frequency    `json:"frequencies,omitempty"`
	States     []tracker.ExcitedState `json:"excitedStates,omitempty"`
	Shields    []tracker.NMRShield    `json:"nmrShields,omitempty"`
	Artifacts  []ArtifactRec          `json:"artifacts,omitempty"`

	Cycle int    `json:"cycle,omitempty"`
	XYZ   string `json:"xyz,omitempty"`
}

// localIDPrefix marks IDs that exist only inside a journal.
const localIDPrefix = "spool-"

// IsLocalID reports whether id was assigned by a journal (as opposed to a
// real backend document ID).
func IsLocalID(id string) bool { return strings.HasPrefix(id, localIDPrefix) }

// DefaultRoot returns the spool root directory: $DFTSTREAM_SPOOL_DIR, else
// ${XDG_STATE_HOME:-$HOME/.local/state}/dftstream/spool. The home
// filesystem is the deliberate choice — on clusters it is shared between
// compute and login nodes, so a journal written inside a job is visible to
// `dftstream sync` on the login node without any copying.
func DefaultRoot() (string, error) {
	if dir := strings.TrimSpace(os.Getenv("DFTSTREAM_SPOOL_DIR")); dir != "" {
		return dir, nil
	}
	if state := strings.TrimSpace(os.Getenv("XDG_STATE_HOME")); state != "" {
		return filepath.Join(state, "dftstream", "spool"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve spool directory: no $DFTSTREAM_SPOOL_DIR, no $XDG_STATE_HOME, and no home directory: %w", err)
	}
	return filepath.Join(home, ".local", "state", "dftstream", "spool"), nil
}

// newJournalID returns a 16-hex-char random identity.
func newJournalID() (string, error) {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("generate journal id: %w", err)
	}
	return hex.EncodeToString(b[:]), nil
}

// sanitizeName keeps a run name filesystem-safe for the journal dir name.
func sanitizeName(name string) string {
	if name == "" {
		return "run"
	}
	out := make([]rune, 0, len(name))
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
			out = append(out, r)
		default:
			out = append(out, '_')
		}
	}
	const maxLen = 64
	if len(out) > maxLen {
		out = out[:maxLen]
	}
	return string(out)
}

// marshalLine encodes a record as one JSON line (with trailing newline).
func marshalLine(v any) ([]byte, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}
