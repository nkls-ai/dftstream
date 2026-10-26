package spool

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/nkls-ai/dftstream/internal/levels"
	"github.com/nkls-ai/dftstream/internal/tracker"
)

// cursor is the sync-progress sidecar (cursor.json). The journal itself is
// append-only and never rewritten; everything sync learns lives here.
type cursor struct {
	Version int `json:"v"`
	// AppliedSeq is the highest journal seq whose op the backend has
	// confirmed. Replay resumes at AppliedSeq+1.
	AppliedSeq int64 `json:"appliedSeq"`
	// IDs maps journal-local IDs (spool-…) to the backend IDs their
	// ensure/create ops returned, so a resumed sync can keep remapping
	// without re-running those ops.
	IDs map[string]string `json:"ids,omitempty"`
}

func loadCursor(dir string) (cursor, error) {
	var c cursor
	b, err := os.ReadFile(filepath.Join(dir, cursorFileName))
	if os.IsNotExist(err) {
		return cursor{Version: 1, IDs: map[string]string{}}, nil
	}
	if err != nil {
		return c, fmt.Errorf("read sync cursor: %w", err)
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return c, fmt.Errorf("parse sync cursor %s: %w. Fix: delete the file to restart this journal's sync from the beginning (already-applied ops are deduplicated server-side)", filepath.Join(dir, cursorFileName), err)
	}
	if c.IDs == nil {
		c.IDs = map[string]string{}
	}
	return c, nil
}

// saveCursor persists the cursor atomically (temp file + fsync + rename) so
// a crash mid-save leaves the previous cursor, never a torn one.
func saveCursor(dir string, c cursor) error {
	b, err := json.Marshal(c)
	if err != nil {
		return fmt.Errorf("encode sync cursor: %w", err)
	}
	tmp := filepath.Join(dir, cursorFileName+".tmp")
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("write sync cursor: %w", err)
	}
	if _, err := f.Write(b); err != nil {
		if cerr := f.Close(); cerr != nil {
			return fmt.Errorf("write sync cursor: %w (and close: %v)", err, cerr)
		}
		return fmt.Errorf("write sync cursor: %w", err)
	}
	if err := f.Sync(); err != nil {
		if cerr := f.Close(); cerr != nil {
			return fmt.Errorf("sync sync-cursor: %w (and close: %v)", err, cerr)
		}
		return fmt.Errorf("sync sync-cursor: %w", err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("close sync cursor: %w", err)
	}
	if err := os.Rename(tmp, filepath.Join(dir, cursorFileName)); err != nil {
		return fmt.Errorf("commit sync cursor: %w", err)
	}
	return nil
}

// ReplaySummary reports what one journal's replay did.
type ReplaySummary struct {
	// Applied is the number of ops replayed in this invocation; Skipped is
	// the number the cursor said were already confirmed by an earlier run.
	Applied int
	Skipped int
	// RunIDs are the backend run IDs this journal's data landed in.
	RunIDs []tracker.RunID
	// Tail is non-nil when the journal's tail was damaged (the valid prefix
	// was still replayed).
	Tail *TailError
}

// Replay uploads one journal to the backend, in journal order, resuming
// from the cursor sidecar and advancing it after every confirmed op. Safe to
// re-run: already-cursored ops are skipped, and the ops that are not
// naturally idempotent go through the backend's key-guarded spool mutations,
// so even a crash between an op's commit and its cursor write cannot
// duplicate data.
func Replay(ctx context.Context, j *Journal, target tracker.SpoolReplayer) (ReplaySummary, error) {
	sum := ReplaySummary{Tail: j.Tail}
	cur, err := loadCursor(j.Dir)
	if err != nil {
		return sum, err
	}

	resolve := func(id string) string {
		if IsLocalID(id) {
			if real, ok := cur.IDs[id]; ok {
				return real
			}
		}
		return id
	}
	seenRun := map[tracker.RunID]bool{}
	noteRun := func(id tracker.RunID) {
		if id != "" && !IsLocalID(string(id)) && !seenRun[id] {
			seenRun[id] = true
			sum.RunIDs = append(sum.RunIDs, id)
		}
	}

	for _, rec := range j.Ops {
		if rec.Seq <= cur.AppliedSeq {
			sum.Skipped++
			// Still collect run IDs from already-applied create ops for the
			// summary.
			if rec.Op == OpCreateRun {
				noteRun(tracker.RunID(resolve(rec.Payload.LocalID)))
			}
			continue
		}
		if err := replayOp(ctx, target, j, rec, &cur, resolve, noteRun); err != nil {
			return sum, fmt.Errorf("journal %s: op %d (%s): %w", j.Dir, rec.Seq, rec.Op, err)
		}
		cur.AppliedSeq = rec.Seq
		if err := saveCursor(j.Dir, cur); err != nil {
			// The op IS applied; losing the cursor write means the next sync
			// re-sends it, which the key guard absorbs. Still fail loudly —
			// an unwritable sidecar breaks resumability.
			return sum, fmt.Errorf("journal %s: op %d applied but cursor not persisted: %w", j.Dir, rec.Seq, err)
		}
		sum.Applied++
	}
	return sum, nil
}

// replayOp executes one journal record against the backend.
func replayOp(
	ctx context.Context,
	target tracker.SpoolReplayer,
	j *Journal,
	rec Record,
	cur *cursor,
	resolve func(string) string,
	noteRun func(tracker.RunID),
) error {
	p := rec.Payload
	switch rec.Op {
	case OpEnsureExperiment:
		id, err := target.EnsureExperiment(ctx, p.OrgID, p.Name)
		if err != nil {
			return err
		}
		cur.IDs[p.LocalID] = string(id)
	case OpEnsureBatch:
		level, err := levels.ParseArtifactLevel(p.ArtifactLevel)
		if err != nil {
			return fmt.Errorf("ensure_batch: %w", err)
		}
		id, err := target.EnsureBatch(ctx, tracker.ExperimentID(resolve(p.ExperimentID)), p.Name, level)
		if err != nil {
			return err
		}
		cur.IDs[p.LocalID] = string(id)
	case OpCreateRun:
		if p.Run == nil {
			return fmt.Errorf("create_run record carries no run payload")
		}
		r := *p.Run
		r.ExperimentID = tracker.ExperimentID(resolve(string(r.ExperimentID)))
		r.BatchID = tracker.BatchID(resolve(string(r.BatchID)))
		if IsLocalID(string(r.ExperimentID)) {
			return fmt.Errorf("experiment id %s is unresolved (its ensure_experiment op did not replay?)", r.ExperimentID)
		}
		id, err := target.SpoolCreateRun(ctx, rec.Key, r)
		if err != nil {
			return err
		}
		cur.IDs[p.LocalID] = string(id)
		noteRun(id)
	case OpUpdateStatus:
		if p.Status == nil {
			return fmt.Errorf("update_status record carries no status payload")
		}
		runID, err := runIDOf(p, resolve, noteRun)
		if err != nil {
			return err
		}
		return target.UpdateRunStatus(ctx, runID, *p.Status)
	case OpAppendEvents:
		runID, err := runIDOf(p, resolve, noteRun)
		if err != nil {
			return err
		}
		return target.SpoolAppendEvents(ctx, rec.Key, runID, p.Events)
	case OpAppendMetrics:
		runID, err := runIDOf(p, resolve, noteRun)
		if err != nil {
			return err
		}
		return target.SpoolAppendMetrics(ctx, rec.Key, runID, p.Metrics)
	case OpAppendSysSamples:
		runID, err := runIDOf(p, resolve, noteRun)
		if err != nil {
			return err
		}
		return target.SpoolAppendSysSamples(ctx, rec.Key, runID, p.SysSamples)
	case OpAppendLogs:
		runID, err := runIDOf(p, resolve, noteRun)
		if err != nil {
			return err
		}
		return target.SpoolAppendLogs(ctx, rec.Key, runID, p.Logs)
	case OpAppendGeometry:
		runID, err := runIDOf(p, resolve, noteRun)
		if err != nil {
			return err
		}
		return target.AppendGeometry(ctx, runID, p.Cycle, p.XYZ)
	case OpSetFrequencies:
		runID, err := runIDOf(p, resolve, noteRun)
		if err != nil {
			return err
		}
		return target.SetFrequencies(ctx, runID, p.Freqs)
	case OpSetExcitedStates:
		runID, err := runIDOf(p, resolve, noteRun)
		if err != nil {
			return err
		}
		return target.SetExcitedStates(ctx, runID, p.States)
	case OpSetNMRShields:
		runID, err := runIDOf(p, resolve, noteRun)
		if err != nil {
			return err
		}
		return target.SetNMRShields(ctx, runID, p.Shields)
	case OpSetArtifacts:
		runID, err := runIDOf(p, resolve, noteRun)
		if err != nil {
			return err
		}
		items, err := loadArtifacts(j, p.Artifacts)
		if err != nil {
			return err
		}
		return target.SetArtifacts(ctx, runID, items)
	case OpAppendArtifacts, OpUpsertArtifacts:
		runID, err := runIDOf(p, resolve, noteRun)
		if err != nil {
			return err
		}
		items, err := loadArtifacts(j, p.Artifacts)
		if err != nil {
			return err
		}
		// Journaled appends replay as upserts: replace-same-name/append-rest
		// makes a re-replay idempotent where a literal append would
		// duplicate rows.
		return target.UpsertArtifacts(ctx, runID, items)
	default:
		return fmt.Errorf("unknown op kind %q — this journal was written by a newer dftstream; upgrade and re-run sync", rec.Op)
	}
	return nil
}

// runIDOf resolves the record's run ID through the cursor's ID map and
// registers it for the summary. A run ID that is still journal-local after
// resolution means its create_run op never replayed — writing rows against
// it would scatter data under a bogus document id, so it is an error.
func runIDOf(p Payload, resolve func(string) string, noteRun func(tracker.RunID)) (tracker.RunID, error) {
	id := tracker.RunID(resolve(p.RunID))
	if IsLocalID(string(id)) {
		return "", fmt.Errorf("run id %s is unresolved (its create_run op did not replay?)", id)
	}
	noteRun(id)
	return id, nil
}

// loadArtifacts rebuilds tracker artifacts from journal records, loading and
// verifying blob bodies.
func loadArtifacts(j *Journal, recs []ArtifactRec) ([]tracker.Artifact, error) {
	items := make([]tracker.Artifact, len(recs))
	for i, r := range recs {
		a := tracker.Artifact{
			Name: r.Name, Path: r.Path, Kind: r.Kind, SizeBytes: r.SizeBytes,
			MTime: r.MTime, ContentText: r.ContentText, Truncated: r.Truncated,
		}
		if r.Blob != nil {
			body, err := j.LoadBlob(*r.Blob)
			if err != nil {
				return nil, fmt.Errorf("artifact %q: %w", r.Name, err)
			}
			a.Body = body
		}
		items[i] = a
	}
	return items, nil
}
