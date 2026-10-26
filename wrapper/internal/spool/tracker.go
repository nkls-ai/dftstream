package spool

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"

	"github.com/nkls-ai/dftstream/internal/levels"
	"github.com/nkls-ai/dftstream/internal/tracker"
)

// Backend is the live-tracker surface Failover forwards to: the full
// Tracker plus the bulk appends (so batches stay batched) — exactly what
// tracker.ConvexHTTPTracker implements.
type Backend interface {
	tracker.Tracker
	tracker.BulkAppender
}

// Mode records why a journal exists. A string type, so the journal header
// carries the same JSON string it always has.
type Mode string

// Mode values recorded in the journal header.
const (
	// ModeOffline: explicit --offline / DFTSTREAM_OFFLINE=1.
	ModeOffline Mode = "offline"
	// ModeFailover: the backend became unreachable mid-command.
	ModeFailover Mode = "failover"
)

// Failover is a tracker that starts live and degrades to journaling the
// moment the backend proves unreachable — or that journals from the start
// when constructed offline. Chemistry is never blocked: once offline, every
// tracker op is appended to the journal and reported as success.
//
// The model is deliberately one-way (mid-run reconnect is out of scope): a
// run is either live-tracked, or journaled from the point of first failure
// onward. Errors that are NOT an unreachable network — auth rejection,
// backend validation failures — do not trigger failover; they surface to the
// caller exactly as before.
type Failover struct {
	mu    sync.Mutex
	inner Backend // nil in forced-offline mode
	w     *Writer // non-nil once journaling
	cfg   WriterConfig
	// stderr receives the single "switched to journal" notice.
	stderr io.Writer
}

// NewOffline returns a Failover that journals from the start and never
// touches the network. The journal is created eagerly so a spool-directory
// problem surfaces before ORCA is launched, not at the first tracked event.
func NewOffline(cfg WriterConfig, stderr io.Writer) (*Failover, error) {
	cfg.Mode = ModeOffline
	w, err := NewWriter(cfg)
	if err != nil {
		return nil, fmt.Errorf("open offline journal: %w", err)
	}
	f := &Failover{w: w, cfg: cfg, stderr: stderr}
	fmt.Fprintf(f.errw(), "[dftstream] offline mode: journaling tracking data to %s (sync later with `dftstream sync`)\n", w.Dir()) //nolint:errcheck — write to stderr is best-effort
	return f, nil
}

// NewFailover returns a Failover that forwards to inner until the backend
// proves unreachable, then journals for the rest of the process.
func NewFailover(inner Backend, cfg WriterConfig, stderr io.Writer) *Failover {
	cfg.Mode = ModeFailover
	return &Failover{inner: inner, cfg: cfg, stderr: stderr}
}

func (f *Failover) errw() io.Writer {
	if f.stderr != nil {
		return f.stderr
	}
	return os.Stderr
}

// journal returns the active journal writer, or nil while live.
func (f *Failover) journal() *Writer {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.w
}

// Journaled reports whether this tracker ended up journaling, and where.
func (f *Failover) Journaled() (dir string, ok bool) {
	if w := f.journal(); w != nil {
		return w.Dir(), true
	}
	return "", false
}

// activate opens the journal after cause proved the backend unreachable.
// Exactly one loud stderr notice is printed. If the journal itself cannot be
// created there is nowhere left to put tracking data — both errors are
// returned and the caller's op fails as it would have without spool mode.
func (f *Failover) activate(cause error) (*Writer, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.w != nil {
		return f.w, nil
	}
	w, err := NewWriter(f.cfg)
	if err != nil {
		return nil, fmt.Errorf("tracker unreachable (%v) and the spool journal could not be created: %w", cause, err)
	}
	f.w = w
	fmt.Fprintf(f.errw(), "[dftstream] tracker unreachable (%v)\n[dftstream] switching to offline journal %s for the rest of this run — sync later with `dftstream sync` from a login node\n", cause, w.Dir()) //nolint:errcheck — write to stderr is best-effort
	return w, nil
}

// run wraps one tracker op: journal when offline; otherwise try live and
// fail over on an unreachable-network error. liveFn performs the live call,
// journalFn appends the equivalent journal record.
func (f *Failover) run(liveFn func() error, journalFn func(w *Writer) error) error {
	if w := f.journal(); w != nil {
		return journalFn(w)
	}
	err := liveFn()
	if err == nil || !tracker.IsUnreachable(err) {
		return err
	}
	w, aerr := f.activate(err)
	if aerr != nil {
		return errors.Join(err, aerr)
	}
	return journalFn(w)
}

func (f *Failover) EnsureExperiment(ctx context.Context, orgID, name string) (tracker.ExperimentID, error) {
	var id tracker.ExperimentID
	err := f.run(func() error {
		var err error
		id, err = f.inner.EnsureExperiment(ctx, orgID, name)
		return err
	}, func(w *Writer) error {
		local := w.nextLocalID("exp")
		if err := w.Append(OpEnsureExperiment, Payload{OrgID: orgID, Name: name, LocalID: local}); err != nil {
			return err
		}
		id = tracker.ExperimentID(local)
		return nil
	})
	return id, err
}

func (f *Failover) EnsureBatch(ctx context.Context, expID tracker.ExperimentID, name string, artifactLevel levels.ArtifactLevel) (tracker.BatchID, error) {
	var id tracker.BatchID
	err := f.run(func() error {
		var err error
		id, err = f.inner.EnsureBatch(ctx, expID, name, artifactLevel)
		return err
	}, func(w *Writer) error {
		local := w.nextLocalID("batch")
		if err := w.Append(OpEnsureBatch, Payload{
			ExperimentID: string(expID), Name: name, ArtifactLevel: artifactLevel.String(), LocalID: local,
		}); err != nil {
			return err
		}
		id = tracker.BatchID(local)
		return nil
	})
	return id, err
}

func (f *Failover) CreateRun(ctx context.Context, r tracker.RunCreate) (tracker.RunID, error) {
	var id tracker.RunID
	err := f.run(func() error {
		var err error
		id, err = f.inner.CreateRun(ctx, r)
		return err
	}, func(w *Writer) error {
		local := w.nextLocalID("run")
		rc := r // copy; the journal owns its payload
		if err := w.Append(OpCreateRun, Payload{LocalID: local, Run: &rc}); err != nil {
			return err
		}
		id = tracker.RunID(local)
		return nil
	})
	return id, err
}

// FindRunByName cannot be answered from a journal; offline it reports
// "not found", which callers already treat as best-effort (parent lineage
// is skipped, never invented).
func (f *Failover) FindRunByName(ctx context.Context, expID tracker.ExperimentID, name string) (tracker.RunID, error) {
	if f.journal() != nil {
		return "", nil
	}
	id, err := f.inner.FindRunByName(ctx, expID, name)
	if err != nil && tracker.IsUnreachable(err) {
		// A lookup is not worth failing over for on its own — but if we are
		// already unreachable the very next write triggers it anyway. Report
		// "not found" and let a write make the switch.
		return "", nil
	}
	return id, err
}

func (f *Failover) UpdateRunStatus(ctx context.Context, runID tracker.RunID, u tracker.StatusUpdate) error {
	return f.run(func() error {
		return f.inner.UpdateRunStatus(ctx, runID, u)
	}, func(w *Writer) error {
		uc := u
		return w.Append(OpUpdateStatus, Payload{RunID: string(runID), Status: &uc})
	})
}

func (f *Failover) AppendEvent(ctx context.Context, runID tracker.RunID, e tracker.Event) error {
	return f.AppendEvents(ctx, runID, []tracker.Event{e})
}

func (f *Failover) AppendEvents(ctx context.Context, runID tracker.RunID, events []tracker.Event) error {
	if len(events) == 0 {
		return nil
	}
	return f.run(func() error {
		return f.inner.AppendEvents(ctx, runID, events)
	}, func(w *Writer) error {
		return w.Append(OpAppendEvents, Payload{RunID: string(runID), Events: events})
	})
}

func (f *Failover) AppendMetric(ctx context.Context, runID tracker.RunID, m tracker.Metric) error {
	return f.AppendMetrics(ctx, runID, []tracker.Metric{m})
}

func (f *Failover) AppendMetrics(ctx context.Context, runID tracker.RunID, metrics []tracker.Metric) error {
	if len(metrics) == 0 {
		return nil
	}
	return f.run(func() error {
		return f.inner.AppendMetrics(ctx, runID, metrics)
	}, func(w *Writer) error {
		return w.Append(OpAppendMetrics, Payload{RunID: string(runID), Metrics: metrics})
	})
}

func (f *Failover) AppendSysSample(ctx context.Context, runID tracker.RunID, s tracker.SysSample) error {
	return f.AppendSysSamples(ctx, runID, []tracker.SysSample{s})
}

func (f *Failover) AppendSysSamples(ctx context.Context, runID tracker.RunID, samples []tracker.SysSample) error {
	if len(samples) == 0 {
		return nil
	}
	return f.run(func() error {
		return f.inner.AppendSysSamples(ctx, runID, samples)
	}, func(w *Writer) error {
		return w.Append(OpAppendSysSamples, Payload{RunID: string(runID), SysSamples: samples})
	})
}

func (f *Failover) AppendLogs(ctx context.Context, runID tracker.RunID, entries []tracker.LogEntry) error {
	if len(entries) == 0 {
		return nil
	}
	return f.run(func() error {
		return f.inner.AppendLogs(ctx, runID, entries)
	}, func(w *Writer) error {
		return w.Append(OpAppendLogs, Payload{RunID: string(runID), Logs: entries})
	})
}

func (f *Failover) AppendGeometry(ctx context.Context, runID tracker.RunID, cycle int, xyz string) error {
	return f.run(func() error {
		return f.inner.AppendGeometry(ctx, runID, cycle, xyz)
	}, func(w *Writer) error {
		return w.Append(OpAppendGeometry, Payload{RunID: string(runID), Cycle: cycle, XYZ: xyz})
	})
}

func (f *Failover) SetFrequencies(ctx context.Context, runID tracker.RunID, items []tracker.Frequency) error {
	return f.run(func() error {
		return f.inner.SetFrequencies(ctx, runID, items)
	}, func(w *Writer) error {
		return w.Append(OpSetFrequencies, Payload{RunID: string(runID), Freqs: items})
	})
}

func (f *Failover) SetExcitedStates(ctx context.Context, runID tracker.RunID, items []tracker.ExcitedState) error {
	return f.run(func() error {
		return f.inner.SetExcitedStates(ctx, runID, items)
	}, func(w *Writer) error {
		return w.Append(OpSetExcitedStates, Payload{RunID: string(runID), States: items})
	})
}

func (f *Failover) SetNMRShields(ctx context.Context, runID tracker.RunID, items []tracker.NMRShield) error {
	return f.run(func() error {
		return f.inner.SetNMRShields(ctx, runID, items)
	}, func(w *Writer) error {
		return w.Append(OpSetNMRShields, Payload{RunID: string(runID), Shields: items})
	})
}

func (f *Failover) SetArtifacts(ctx context.Context, runID tracker.RunID, items []tracker.Artifact) error {
	return f.artifactOp(OpSetArtifacts, runID, items, func() error {
		return f.inner.SetArtifacts(ctx, runID, items)
	})
}

func (f *Failover) AppendArtifacts(ctx context.Context, runID tracker.RunID, items []tracker.Artifact) error {
	return f.artifactOp(OpAppendArtifacts, runID, items, func() error {
		return f.inner.AppendArtifacts(ctx, runID, items)
	})
}

func (f *Failover) UpsertArtifacts(ctx context.Context, runID tracker.RunID, items []tracker.Artifact) error {
	return f.artifactOp(OpUpsertArtifacts, runID, items, func() error {
		return f.inner.UpsertArtifacts(ctx, runID, items)
	})
}

// artifactOp journals an artifact write, externalizing bodies to blob files.
func (f *Failover) artifactOp(op OpKind, runID tracker.RunID, items []tracker.Artifact, liveFn func() error) error {
	return f.run(liveFn, func(w *Writer) error {
		recs := make([]ArtifactRec, len(items))
		for i, a := range items {
			rec := ArtifactRec{
				Name: a.Name, Path: a.Path, Kind: a.Kind, SizeBytes: a.SizeBytes,
				MTime: a.MTime, ContentText: a.ContentText, Truncated: a.Truncated,
			}
			if len(a.Body) > 0 {
				ref, err := w.WriteBlob(a.Name, a.Body)
				if err != nil {
					return fmt.Errorf("journal artifact %q: %w", a.Name, err)
				}
				rec.Blob = &ref
			}
			recs[i] = rec
		}
		return w.Append(op, Payload{RunID: string(runID), Artifacts: recs})
	})
}

// BackendVersion forwards the handshake while live; once (or when forced)
// offline there is no deployment to interrogate, so it reports the
// handshake as unperformable — callers treat that as "unknown, carry on".
func (f *Failover) BackendVersion(ctx context.Context) (tracker.BackendVersion, error) {
	if f.journal() != nil || f.inner == nil {
		return tracker.BackendVersion{}, tracker.ErrVersionUnsupported
	}
	vr, ok := f.inner.(tracker.VersionReporter)
	if !ok {
		return tracker.BackendVersion{}, tracker.ErrVersionUnsupported
	}
	return vr.BackendVersion(ctx)
}

// Close makes the journal durable (fsync) and prints the sync reminder; the
// inner tracker, when present, is closed too.
func (f *Failover) Close(ctx context.Context) error {
	var errs []error
	if w := f.journal(); w != nil {
		n := w.Count()
		if err := w.Close(); err != nil {
			errs = append(errs, err)
		} else {
			fmt.Fprintf(f.errw(), "[dftstream] journaled %d tracker operation(s) to %s\n[dftstream] upload them with: dftstream sync\n", n, w.Dir()) //nolint:errcheck — write to stderr is best-effort
		}
	}
	if f.inner != nil {
		if err := f.inner.Close(ctx); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

var (
	_ tracker.Tracker         = (*Failover)(nil)
	_ tracker.BulkAppender    = (*Failover)(nil)
	_ tracker.VersionReporter = (*Failover)(nil)
)
