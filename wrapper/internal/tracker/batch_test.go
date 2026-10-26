package tracker

import (
	"context"
	"testing"
	"time"

	"github.com/nkls-ai/dftstream/internal/levels"
)

func TestBatchingTrackerCloseFlushesQueuedData(t *testing.T) {
	sink := &recordingSink{}
	bt := WrapBatching(sink)

	if err := bt.AppendEvent(context.Background(), "run", Event{Seq: 1, TS: time.Unix(1, 0), Kind: "event"}); err != nil {
		t.Fatal(err)
	}
	if err := bt.AppendMetric(context.Background(), "run", Metric{Key: "energy", TS: time.Unix(2, 0), Value: -1}); err != nil {
		t.Fatal(err)
	}
	if err := bt.AppendSysSample(context.Background(), "run", SysSample{TS: time.Unix(3, 0), CPUPct: 12.5, RSSMB: 42, Threads: 4}); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := bt.Close(ctx); err != nil {
		t.Fatalf("Close: %v", err)
	}

	if len(sink.events) != 1 {
		t.Fatalf("events flushed = %d, want 1", len(sink.events))
	}
	if len(sink.metrics) != 1 {
		t.Fatalf("metrics flushed = %d, want 1", len(sink.metrics))
	}
	if len(sink.samples) != 1 {
		t.Fatalf("sys samples flushed = %d, want 1", len(sink.samples))
	}
}

func TestOpenRejectsUnsupportedTrackerScheme(t *testing.T) {
	if _, err := Open("sqlite:///tmp/dftstream.db"); err == nil {
		t.Fatal("Open accepted unsupported scheme")
	}
}

func TestBatchingTrackerFlushesLogs(t *testing.T) {
	sink := &recordingSink{}
	bt := WrapBatching(sink)

	entries := []LogEntry{
		{TS: time.Unix(1, 0), Level: "info", Message: "hello"},
		{TS: time.Unix(2, 0), Level: "warn", Message: "oops", Fields: map[string]any{"code": 42}},
	}
	if err := bt.AppendLogs(context.Background(), "run", entries); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := bt.Close(ctx); err != nil {
		t.Fatalf("Close: %v", err)
	}

	if len(sink.logs) != 2 {
		t.Fatalf("logs flushed = %d, want 2", len(sink.logs))
	}
	if sink.logs[0].Message != "hello" {
		t.Errorf("logs[0].Message = %q, want %q", sink.logs[0].Message, "hello")
	}
	if sink.logs[1].Fields["code"] != 42 {
		t.Errorf("logs[1].Fields[code] = %v, want 42", sink.logs[1].Fields["code"])
	}
}

func TestBatchingTrackerDelegatesAppendArtifacts(t *testing.T) {
	rec := &artifactRecorder{}
	bt := WrapBatching(rec)

	items := []Artifact{
		{Name: "density.cube", Kind: "cube", SizeBytes: 1024},
	}
	if err := bt.AppendArtifacts(context.Background(), "run", items); err != nil {
		t.Fatal(err)
	}
	// AppendArtifacts passes through immediately (no batching).
	if len(rec.appended) != 1 {
		t.Fatalf("appended = %d, want 1", len(rec.appended))
	}
	if rec.appended[0].Name != "density.cube" {
		t.Errorf("name = %q", rec.appended[0].Name)
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	bt.Close(ctx)
}

func TestBatchingTrackerDelegatesSetArtifacts(t *testing.T) {
	rec := &artifactRecorder{}
	bt := WrapBatching(rec)

	items := []Artifact{
		{Name: "input.inp", Kind: "input", SizeBytes: 256},
		{Name: "output.out", Kind: "output", SizeBytes: 8192},
	}
	if err := bt.SetArtifacts(context.Background(), "run", items); err != nil {
		t.Fatal(err)
	}
	if len(rec.set) != 2 {
		t.Fatalf("set = %d, want 2", len(rec.set))
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	bt.Close(ctx)
}

func TestBatchingTrackerFindRunByName(t *testing.T) {
	sink := &recordingSink{}
	bt := WrapBatching(sink)

	id, err := bt.FindRunByName(context.Background(), "exp", "run")
	if err != nil {
		t.Fatal(err)
	}
	if id != "" {
		t.Fatalf("expected empty, got %q", id)
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	bt.Close(ctx)
}

func TestBatchingTrackerRejectsAppendAfterClose(t *testing.T) {
	bt := WrapBatching(&recordingSink{})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := bt.Close(ctx); err != nil {
		t.Fatalf("Close: %v", err)
	}

	if err := bt.AppendEvent(context.Background(), "run", Event{Seq: 1, Kind: "event"}); err == nil {
		t.Fatal("AppendEvent after Close succeeded")
	}
}

type recordingSink struct {
	events  []Event
	metrics []Metric
	samples []SysSample
	logs    []LogEntry
}

func (r *recordingSink) EnsureExperiment(context.Context, string, string) (ExperimentID, error) {
	return "exp", nil
}

func (r *recordingSink) EnsureBatch(context.Context, ExperimentID, string, levels.ArtifactLevel) (BatchID, error) {
	return "batch", nil
}

func (r *recordingSink) CreateRun(context.Context, RunCreate) (RunID, error) { return "run", nil }
func (r *recordingSink) FindRunByName(context.Context, ExperimentID, string) (RunID, error) {
	return "", nil
}

func (r *recordingSink) UpdateRunStatus(context.Context, RunID, StatusUpdate) error { return nil }

func (r *recordingSink) AppendEvent(_ context.Context, _ RunID, e Event) error {
	r.events = append(r.events, e)
	return nil
}

func (r *recordingSink) AppendEvents(_ context.Context, _ RunID, events []Event) error {
	r.events = append(r.events, events...)
	return nil
}

func (r *recordingSink) AppendMetric(_ context.Context, _ RunID, m Metric) error {
	r.metrics = append(r.metrics, m)
	return nil
}

func (r *recordingSink) AppendMetrics(_ context.Context, _ RunID, metrics []Metric) error {
	r.metrics = append(r.metrics, metrics...)
	return nil
}

func (r *recordingSink) AppendGeometry(context.Context, RunID, int, string) error { return nil }

func (r *recordingSink) SetFrequencies(context.Context, RunID, []Frequency) error { return nil }

func (r *recordingSink) AppendSysSample(_ context.Context, _ RunID, s SysSample) error {
	r.samples = append(r.samples, s)
	return nil
}

func (r *recordingSink) AppendSysSamples(_ context.Context, _ RunID, samples []SysSample) error {
	r.samples = append(r.samples, samples...)
	return nil
}

func (r *recordingSink) SetArtifacts(context.Context, RunID, []Artifact) error    { return nil }
func (r *recordingSink) AppendArtifacts(context.Context, RunID, []Artifact) error { return nil }
func (r *recordingSink) UpsertArtifacts(context.Context, RunID, []Artifact) error { return nil }
func (r *recordingSink) AppendLogs(_ context.Context, _ RunID, entries []LogEntry) error {
	r.logs = append(r.logs, entries...)
	return nil
}

func (r *recordingSink) SetExcitedStates(context.Context, RunID, []ExcitedState) error { return nil }
func (r *recordingSink) SetNMRShields(context.Context, RunID, []NMRShield) error       { return nil }
func (r *recordingSink) Close(context.Context) error                                   { return nil }

// artifactRecorder tracks SetArtifacts/AppendArtifacts calls and also
// satisfies Tracker (inheriting recordingSink for the rest).
type artifactRecorder struct {
	recordingSink
	set      []Artifact
	appended []Artifact
}

func (a *artifactRecorder) SetArtifacts(_ context.Context, _ RunID, items []Artifact) error {
	a.set = append(a.set, items...)
	return nil
}

func (a *artifactRecorder) AppendArtifacts(_ context.Context, _ RunID, items []Artifact) error {
	a.appended = append(a.appended, items...)
	return nil
}
