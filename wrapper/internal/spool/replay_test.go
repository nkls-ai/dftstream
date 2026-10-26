package spool

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nkls-ai/dftstream/internal/levels"
	"github.com/nkls-ai/dftstream/internal/tracker"
)

// fakeReplayer captures every replayed op in order, mimicking the backend's
// idempotency guard: a Spool* call with an already-seen key is recorded as a
// dedupe hit and not re-applied.
type fakeReplayer struct {
	ops     []string // applied ops, in order
	keys    map[string]tracker.RunID
	deduped int
	failOn  string // op label that fails once, then is cleared
	created int
}

func newFakeReplayer() *fakeReplayer {
	return &fakeReplayer{keys: map[string]tracker.RunID{}}
}

func (f *fakeReplayer) apply(label string) error {
	if f.failOn == label {
		f.failOn = ""
		return fmt.Errorf("injected failure at %s", label)
	}
	f.ops = append(f.ops, label)
	return nil
}

func (f *fakeReplayer) guarded(key, label string) error {
	if _, seen := f.keys[key]; seen {
		f.deduped++
		return nil
	}
	if err := f.apply(label); err != nil {
		return err
	}
	f.keys[key] = ""
	return nil
}

func (f *fakeReplayer) SpoolCreateRun(_ context.Context, key string, r tracker.RunCreate) (tracker.RunID, error) {
	if id, seen := f.keys[key]; seen {
		f.deduped++
		return id, nil
	}
	if err := f.apply("create_run " + r.Name + " in " + string(r.ExperimentID)); err != nil {
		return "", err
	}
	f.created++
	id := tracker.RunID(fmt.Sprintf("run-%d", f.created))
	f.keys[key] = id
	return id, nil
}
func (f *fakeReplayer) SpoolAppendEvents(_ context.Context, key string, runID tracker.RunID, ev []tracker.Event) error {
	return f.guarded(key, fmt.Sprintf("append_events %s x%d", runID, len(ev)))
}
func (f *fakeReplayer) SpoolAppendMetrics(_ context.Context, key string, runID tracker.RunID, ms []tracker.Metric) error {
	return f.guarded(key, fmt.Sprintf("append_metrics %s x%d", runID, len(ms)))
}
func (f *fakeReplayer) SpoolAppendLogs(_ context.Context, key string, runID tracker.RunID, ls []tracker.LogEntry) error {
	return f.guarded(key, fmt.Sprintf("append_logs %s x%d", runID, len(ls)))
}
func (f *fakeReplayer) SpoolAppendSysSamples(_ context.Context, key string, runID tracker.RunID, ss []tracker.SysSample) error {
	return f.guarded(key, fmt.Sprintf("append_sys_samples %s x%d", runID, len(ss)))
}
func (f *fakeReplayer) EnsureExperiment(_ context.Context, orgID, name string) (tracker.ExperimentID, error) {
	if err := f.apply("ensure_experiment " + name); err != nil {
		return "", err
	}
	return tracker.ExperimentID("exp-" + name), nil
}
func (f *fakeReplayer) EnsureBatch(_ context.Context, expID tracker.ExperimentID, name string, _ levels.ArtifactLevel) (tracker.BatchID, error) {
	if err := f.apply("ensure_batch " + name + " in " + string(expID)); err != nil {
		return "", err
	}
	return tracker.BatchID("batch-" + name), nil
}
func (f *fakeReplayer) UpdateRunStatus(_ context.Context, runID tracker.RunID, u tracker.StatusUpdate) error {
	return f.apply(fmt.Sprintf("update_status %s %s", runID, u.Status))
}
func (f *fakeReplayer) AppendGeometry(_ context.Context, runID tracker.RunID, cycle int, _ string) error {
	return f.apply(fmt.Sprintf("append_geometry %s %d", runID, cycle))
}
func (f *fakeReplayer) SetFrequencies(_ context.Context, runID tracker.RunID, items []tracker.Frequency) error {
	return f.apply(fmt.Sprintf("set_frequencies %s x%d", runID, len(items)))
}
func (f *fakeReplayer) SetExcitedStates(_ context.Context, runID tracker.RunID, items []tracker.ExcitedState) error {
	return f.apply(fmt.Sprintf("set_excited_states %s x%d", runID, len(items)))
}
func (f *fakeReplayer) SetNMRShields(_ context.Context, runID tracker.RunID, items []tracker.NMRShield) error {
	return f.apply(fmt.Sprintf("set_nmr_shields %s x%d", runID, len(items)))
}
func (f *fakeReplayer) SetArtifacts(_ context.Context, runID tracker.RunID, items []tracker.Artifact) error {
	return f.apply(fmt.Sprintf("set_artifacts %s x%d body=%s", runID, len(items), firstBody(items)))
}
func (f *fakeReplayer) UpsertArtifacts(_ context.Context, runID tracker.RunID, items []tracker.Artifact) error {
	return f.apply(fmt.Sprintf("upsert_artifacts %s x%d", runID, len(items)))
}

func firstBody(items []tracker.Artifact) string {
	for _, a := range items {
		if len(a.Body) > 0 {
			return string(a.Body)
		}
	}
	return ""
}

var _ tracker.SpoolReplayer = (*fakeReplayer)(nil)

// offlineJournal produces a realistic offline journal via the Failover
// tracker: ensure experiment + batch, create run, status, appends, artifacts.
func offlineJournal(t *testing.T) *Journal {
	t.Helper()
	fo, err := NewOffline(WriterConfig{Root: t.TempDir(), RunName: "h2", ExperimentName: "gas"}, &discard{})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	expID, err := fo.EnsureExperiment(ctx, "", "gas")
	if err != nil {
		t.Fatal(err)
	}
	batchID, err := fo.EnsureBatch(ctx, expID, "b1", levels.ArtifactsIO)
	if err != nil {
		t.Fatal(err)
	}
	runID, err := fo.CreateRun(ctx, tracker.RunCreate{ExperimentID: expID, BatchID: batchID, Name: "h2"})
	if err != nil {
		t.Fatal(err)
	}
	steps := []error{
		fo.UpdateRunStatus(ctx, runID, tracker.StatusUpdate{Status: tracker.StatusRunning}),
		fo.AppendEvents(ctx, runID, []tracker.Event{{Seq: 1, TS: time.Now(), Kind: "scf"}}),
		fo.AppendMetrics(ctx, runID, []tracker.Metric{{Key: "scf_iter_energy", TS: time.Now(), Value: -2.5}}),
		fo.AppendGeometry(ctx, runID, 1, "xyz"),
		fo.AppendLogs(ctx, runID, []tracker.LogEntry{{TS: time.Now(), Level: "info", Message: "m"}}),
		fo.SetFrequencies(ctx, runID, []tracker.Frequency{{Idx: 0, Wavenumber: 100}}),
		fo.AppendArtifacts(ctx, runID, []tracker.Artifact{{Name: "extra.cube"}}),
		fo.SetArtifacts(ctx, runID, []tracker.Artifact{{Name: "h2.out", Body: []byte("out-body")}}),
		fo.UpdateRunStatus(ctx, runID, tracker.StatusUpdate{Status: tracker.StatusFinished}),
	}
	for i, err := range steps {
		if err != nil {
			t.Fatalf("step %d: %v", i, err)
		}
	}
	dir, _ := fo.Journaled()
	if err := fo.Close(ctx); err != nil {
		t.Fatal(err)
	}
	j, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	return j
}

type discard struct{}

func (discard) Write(p []byte) (int, error) { return len(p), nil }

func TestReplayPreservesOrderAndMapsIDs(t *testing.T) {
	j := offlineJournal(t)
	fr := newFakeReplayer()
	sum, err := Replay(context.Background(), j, fr)
	if err != nil {
		t.Fatalf("Replay: %v", err)
	}
	if sum.Applied != len(j.Ops) || sum.Skipped != 0 {
		t.Fatalf("summary = %+v, want %d applied", sum, len(j.Ops))
	}
	want := []string{
		"ensure_experiment gas",
		"ensure_batch b1 in exp-gas",
		"create_run h2 in exp-gas",
		"update_status run-1 running",
		"append_events run-1 x1",
		"append_metrics run-1 x1",
		"append_geometry run-1 1",
		"append_logs run-1 x1",
		"set_frequencies run-1 x1",
		"upsert_artifacts run-1 x1", // journaled append replays as upsert
		"set_artifacts run-1 x1 body=out-body",
		"update_status run-1 finished",
	}
	if len(fr.ops) != len(want) {
		t.Fatalf("ops:\n%v\nwant:\n%v", fr.ops, want)
	}
	for i := range want {
		if fr.ops[i] != want[i] {
			t.Fatalf("op %d = %q, want %q\nall: %v", i, fr.ops[i], want[i], fr.ops)
		}
	}
	if len(sum.RunIDs) != 1 || sum.RunIDs[0] != "run-1" {
		t.Fatalf("run ids = %v", sum.RunIDs)
	}
}

func TestReplayIsIdempotentAcrossReruns(t *testing.T) {
	j := offlineJournal(t)
	fr := newFakeReplayer()
	if _, err := Replay(context.Background(), j, fr); err != nil {
		t.Fatal(err)
	}
	applied := len(fr.ops)

	// Second run with the cursor intact: everything is skipped client-side.
	sum2, err := Replay(context.Background(), j, fr)
	if err != nil {
		t.Fatal(err)
	}
	if sum2.Applied != 0 || sum2.Skipped != len(j.Ops) {
		t.Fatalf("cursor resume summary = %+v", sum2)
	}
	if len(fr.ops) != applied {
		t.Fatalf("cursor-skipped replay still applied ops: %v", fr.ops[applied:])
	}

	// Worst case: the cursor is lost entirely (crash before any sidecar
	// write survived). Every key is re-sent; the backend guard must dedupe
	// the guarded ops, and the unguarded ones must be harmless re-applies of
	// naturally idempotent mutations.
	if err := os.Remove(filepath.Join(j.Dir, cursorFileName)); err != nil {
		t.Fatal(err)
	}
	sum3, err := Replay(context.Background(), j, fr)
	if err != nil {
		t.Fatal(err)
	}
	if sum3.Applied != len(j.Ops) {
		t.Fatalf("cursorless replay summary = %+v", sum3)
	}
	if fr.created != 1 {
		t.Fatalf("cursorless re-replay created %d runs, want 1 (guard must dedupe)", fr.created)
	}
	// The guarded ops in this journal are create_run, append_events,
	// append_metrics and append_logs: exactly those must have been deduped
	// by their keys on the cursorless re-replay.
	if fr.deduped != 4 {
		t.Fatalf("deduped = %d, want 4", fr.deduped)
	}
	// The re-applied unguarded ops must reference the SAME backend run.
	if len(sum3.RunIDs) != 1 || sum3.RunIDs[0] != "run-1" {
		t.Fatalf("cursorless replay run ids = %v", sum3.RunIDs)
	}
}

func TestReplayResumesAfterMidwayFailure(t *testing.T) {
	j := offlineJournal(t)
	fr := newFakeReplayer()
	fr.failOn = "append_geometry run-1 1"

	sum, err := Replay(context.Background(), j, fr)
	if err == nil {
		t.Fatal("expected injected failure")
	}
	firstApplied := sum.Applied

	sum2, err := Replay(context.Background(), j, fr)
	if err != nil {
		t.Fatalf("resume: %v", err)
	}
	if sum2.Skipped != firstApplied {
		t.Fatalf("resume skipped %d, want %d", sum2.Skipped, firstApplied)
	}
	if sum2.Applied != len(j.Ops)-firstApplied {
		t.Fatalf("resume applied %d, want %d", sum2.Applied, len(j.Ops)-firstApplied)
	}
	// No op ran twice.
	seen := map[string]int{}
	for _, op := range fr.ops {
		seen[op]++
	}
	for op, n := range seen {
		// update_status appears twice in the journal (running, finished) as
		// distinct labels, so any count > 1 here is a genuine double-apply.
		if n > 1 {
			t.Fatalf("op %q applied %d times", op, n)
		}
	}
}

func TestReplayReportsCorruptTailButShipsPrefix(t *testing.T) {
	j := offlineJournal(t)
	// Damage the tail: drop the final record's closing bytes.
	path := JournalPath(j.Dir)
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b[:len(b)-10], 0o600); err != nil {
		t.Fatal(err)
	}
	damaged, err := Load(j.Dir)
	if err != nil {
		t.Fatal(err)
	}
	if damaged.Tail == nil {
		t.Fatal("tail damage not detected")
	}
	fr := newFakeReplayer()
	sum, err := Replay(context.Background(), damaged, fr)
	if err != nil {
		t.Fatalf("Replay of damaged journal: %v", err)
	}
	if sum.Tail == nil {
		t.Fatal("summary lost the tail error")
	}
	if sum.Applied != len(damaged.Ops) || len(damaged.Ops) != len(j.Ops)-1 {
		t.Fatalf("applied %d of %d valid ops (original %d)", sum.Applied, len(damaged.Ops), len(j.Ops))
	}
}
