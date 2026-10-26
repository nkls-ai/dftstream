package spool

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/nkls-ai/dftstream/internal/levels"
	"github.com/nkls-ai/dftstream/internal/tracker"
)

// flakyBackend is a live tracker that succeeds until failAfter calls have
// been made, then returns failErr from every mutating call.
type flakyBackend struct {
	calls     int
	failAfter int
	failErr   error
	log       []string
}

func (f *flakyBackend) step(op string) error {
	f.calls++
	if f.calls > f.failAfter {
		return f.failErr
	}
	f.log = append(f.log, op)
	return nil
}

func (f *flakyBackend) EnsureExperiment(_ context.Context, _, name string) (tracker.ExperimentID, error) {
	return "exp-live", f.step("ensure_experiment " + name)
}
func (f *flakyBackend) EnsureBatch(context.Context, tracker.ExperimentID, string, levels.ArtifactLevel) (tracker.BatchID, error) {
	return "batch-live", f.step("ensure_batch")
}
func (f *flakyBackend) CreateRun(_ context.Context, r tracker.RunCreate) (tracker.RunID, error) {
	return "run-live", f.step("create_run " + r.Name)
}
func (f *flakyBackend) FindRunByName(context.Context, tracker.ExperimentID, string) (tracker.RunID, error) {
	return "", nil
}
func (f *flakyBackend) UpdateRunStatus(context.Context, tracker.RunID, tracker.StatusUpdate) error {
	return f.step("update_status")
}
func (f *flakyBackend) AppendEvent(_ context.Context, runID tracker.RunID, e tracker.Event) error {
	return f.AppendEvents(context.Background(), runID, []tracker.Event{e})
}
func (f *flakyBackend) AppendEvents(_ context.Context, _ tracker.RunID, ev []tracker.Event) error {
	return f.step(fmt.Sprintf("append_events x%d", len(ev)))
}
func (f *flakyBackend) AppendMetric(_ context.Context, runID tracker.RunID, m tracker.Metric) error {
	return f.AppendMetrics(context.Background(), runID, []tracker.Metric{m})
}
func (f *flakyBackend) AppendMetrics(_ context.Context, _ tracker.RunID, ms []tracker.Metric) error {
	return f.step(fmt.Sprintf("append_metrics x%d", len(ms)))
}
func (f *flakyBackend) AppendSysSample(_ context.Context, runID tracker.RunID, s tracker.SysSample) error {
	return f.AppendSysSamples(context.Background(), runID, []tracker.SysSample{s})
}
func (f *flakyBackend) AppendSysSamples(_ context.Context, _ tracker.RunID, ss []tracker.SysSample) error {
	return f.step(fmt.Sprintf("append_sys_samples x%d", len(ss)))
}
func (f *flakyBackend) AppendLogs(_ context.Context, _ tracker.RunID, ls []tracker.LogEntry) error {
	return f.step(fmt.Sprintf("append_logs x%d", len(ls)))
}
func (f *flakyBackend) AppendGeometry(context.Context, tracker.RunID, int, string) error {
	return f.step("append_geometry")
}
func (f *flakyBackend) SetFrequencies(context.Context, tracker.RunID, []tracker.Frequency) error {
	return f.step("set_frequencies")
}
func (f *flakyBackend) SetExcitedStates(context.Context, tracker.RunID, []tracker.ExcitedState) error {
	return f.step("set_excited_states")
}
func (f *flakyBackend) SetNMRShields(context.Context, tracker.RunID, []tracker.NMRShield) error {
	return f.step("set_nmr_shields")
}
func (f *flakyBackend) SetArtifacts(context.Context, tracker.RunID, []tracker.Artifact) error {
	return f.step("set_artifacts")
}
func (f *flakyBackend) AppendArtifacts(context.Context, tracker.RunID, []tracker.Artifact) error {
	return f.step("append_artifacts")
}
func (f *flakyBackend) UpsertArtifacts(context.Context, tracker.RunID, []tracker.Artifact) error {
	return f.step("upsert_artifacts")
}
func (f *flakyBackend) Close(context.Context) error { return nil }

var errConnRefused = &url.Error{Op: "Post", URL: "http://127.0.0.1:9/api/mutation", Err: errors.New("connect: connection refused")}

func TestFailoverSwitchesToJournalOnUnreachable(t *testing.T) {
	be := &flakyBackend{failAfter: 2, failErr: errConnRefused}
	var notices strings.Builder
	fo := NewFailover(be, WriterConfig{Root: t.TempDir(), RunName: "run"}, &notices)
	ctx := context.Background()

	expID, err := fo.EnsureExperiment(ctx, "", "exp")
	if err != nil || expID != "exp-live" {
		t.Fatalf("live EnsureExperiment = %q, %v", expID, err)
	}
	runID, err := fo.CreateRun(ctx, tracker.RunCreate{ExperimentID: expID, Name: "run"})
	if err != nil || runID != "run-live" {
		t.Fatalf("live CreateRun = %q, %v", runID, err)
	}

	// Third call hits the dead network: the op must be journaled, not lost.
	if err := fo.UpdateRunStatus(ctx, runID, tracker.StatusUpdate{Status: tracker.StatusRunning}); err != nil {
		t.Fatalf("UpdateRunStatus after outage: %v", err)
	}
	if err := fo.AppendEvents(ctx, runID, []tracker.Event{{Seq: 1, TS: time.Now(), Kind: "k"}}); err != nil {
		t.Fatalf("AppendEvents after outage: %v", err)
	}
	dir, ok := fo.Journaled()
	if !ok {
		t.Fatal("failover did not journal")
	}
	if got := notices.String(); strings.Count(got, "tracker unreachable") != 1 {
		t.Fatalf("want exactly one unreachable notice, got: %q", got)
	}
	if err := fo.Close(ctx); err != nil {
		t.Fatalf("Close: %v", err)
	}

	j, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if j.Header.Mode != ModeFailover {
		t.Fatalf("journal mode = %q", j.Header.Mode)
	}
	if len(j.Ops) != 2 || j.Ops[0].Op != OpUpdateStatus || j.Ops[1].Op != OpAppendEvents {
		t.Fatalf("journaled ops = %+v", j.Ops)
	}
	// Mid-run failover: ops must reference the REAL run id assigned live.
	if j.Ops[0].Payload.RunID != "run-live" || j.Ops[1].Payload.RunID != "run-live" {
		t.Fatalf("journaled run ids = %q, %q, want run-live", j.Ops[0].Payload.RunID, j.Ops[1].Payload.RunID)
	}
	// And the live calls made before the outage stayed live.
	if len(be.log) != 2 {
		t.Fatalf("live calls = %v", be.log)
	}
}

func TestFailoverDoesNotSwallowAuthErrors(t *testing.T) {
	authErr := fmt.Errorf("Convex function runs:create returned HTTP 401 (%w): nope", tracker.ErrUnauthorized)
	be := &flakyBackend{failAfter: 0, failErr: authErr}
	fo := NewFailover(be, WriterConfig{Root: t.TempDir(), RunName: "run"}, &strings.Builder{})

	_, err := fo.EnsureExperiment(context.Background(), "", "exp")
	if !errors.Is(err, tracker.ErrUnauthorized) {
		t.Fatalf("auth error was not surfaced: %v", err)
	}
	if _, ok := fo.Journaled(); ok {
		t.Fatal("auth failure must not trigger journaling")
	}
}

func TestFailoverDoesNotSwallowBackendErrors(t *testing.T) {
	// A 400-class backend error means the network worked; journaling it
	// would hide a real bug.
	be := &flakyBackend{failAfter: 0, failErr: errors.New("Convex function runs:create returned HTTP 400: validator error")}
	fo := NewFailover(be, WriterConfig{Root: t.TempDir(), RunName: "run"}, &strings.Builder{})
	if _, err := fo.CreateRun(context.Background(), tracker.RunCreate{Name: "x"}); err == nil {
		t.Fatal("backend error was swallowed")
	}
	if _, ok := fo.Journaled(); ok {
		t.Fatal("backend error must not trigger journaling")
	}
}

func TestOfflineJournalsEverythingWithoutBackend(t *testing.T) {
	var notices strings.Builder
	fo, err := NewOffline(WriterConfig{Root: t.TempDir(), RunName: "h2"}, &notices)
	if err != nil {
		t.Fatalf("NewOffline: %v", err)
	}
	ctx := context.Background()
	expID, err := fo.EnsureExperiment(ctx, "org", "exp")
	if err != nil || !IsLocalID(string(expID)) {
		t.Fatalf("offline EnsureExperiment = %q, %v", expID, err)
	}
	runID, err := fo.CreateRun(ctx, tracker.RunCreate{ExperimentID: expID, Name: "h2"})
	if err != nil || !IsLocalID(string(runID)) {
		t.Fatalf("offline CreateRun = %q, %v", runID, err)
	}
	if err := fo.SetArtifacts(ctx, runID, []tracker.Artifact{{Name: "h2.out", Body: []byte("data")}}); err != nil {
		t.Fatalf("offline SetArtifacts: %v", err)
	}
	dir, _ := fo.Journaled()
	if err := fo.Close(ctx); err != nil {
		t.Fatalf("Close: %v", err)
	}
	j, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(j.Ops) != 3 || j.Header.Mode != ModeOffline {
		t.Fatalf("ops=%d mode=%q", len(j.Ops), j.Header.Mode)
	}
	art := j.Ops[2].Payload.Artifacts[0]
	if art.Blob == nil {
		t.Fatal("artifact body was not externalized to a blob")
	}
	if body, err := j.LoadBlob(*art.Blob); err != nil || string(body) != "data" {
		t.Fatalf("blob = %q, %v", body, err)
	}
}

var _ Backend = (*flakyBackend)(nil)
