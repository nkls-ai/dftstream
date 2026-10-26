package spool_test

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nkls-ai/dftstream/internal/levels"
	"github.com/nkls-ai/dftstream/internal/runner"
	"github.com/nkls-ai/dftstream/internal/spool"
	"github.com/nkls-ai/dftstream/internal/tracker"
)

// fakeOrcaScript mirrors the runner package's test harness: a shell script
// that plays back a canned ORCA transcript so the full parser → tracker
// pipeline runs without ORCA installed.
const fakeOrcaScript = `#!/bin/sh
cat <<'EOF'
Program Version 6.1.0
GEOMETRY OPTIMIZATION CYCLE   1
CARTESIAN COORDINATES (ANGSTROEM)
---------------------------------
C      0.000000   0.000000   0.000000
H      0.000000   0.000000   1.000000

----------------------------------------D-I-I-S--------------------------------------------
Iteration    Energy (Eh)           Delta-E    RMSDP     MaxDP     DIISErr   Damp  Time(sec)
-------------------------------------------------------------------------------------------
    1    -2.0000000000000000     0.00e+00  3.77e-03  7.50e-02  1.45e-01  0.700   2.1
    2    -2.5000000000000000    -5.00e-01  2.80e-03  3.73e-02  4.69e-02  0.700   1.8
               *****************************************************
               *                     SUCCESS                       *
SCF CONVERGED AFTER   2 CYCLES
Total Energy       :         -2.50000000 Eh
FINAL SINGLE POINT ENERGY      -2.500000000000
TOTAL RUN TIME: 0 days 0 hours 0 minutes 1 seconds 5 msec
ORCA TERMINATED NORMALLY
EOF
`

// TestOfflineRunEndToEnd drives a full `dftstream run --offline` through
// the real runner against a fake ORCA: zero network, ORCA completes, and the
// journal ends up holding the run's whole lifecycle for a later sync.
func TestOfflineRunEndToEnd(t *testing.T) {
	dir := t.TempDir()
	input := filepath.Join(dir, "h2.inp")
	if err := os.WriteFile(input, []byte("! OPT\n%pal nprocs 2 end\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	orca := filepath.Join(dir, "orca")
	if err := os.WriteFile(orca, []byte(fakeOrcaScript), 0o755); err != nil {
		t.Fatal(err)
	}

	spoolRoot := t.TempDir()
	var notices strings.Builder
	fo, err := spool.NewOffline(spool.WriterConfig{
		Root:           spoolRoot,
		RunName:        "h2",
		ExperimentName: "exp",
	}, &notices)
	if err != nil {
		t.Fatalf("NewOffline: %v", err)
	}
	// Exactly the composition `dftstream run --offline` uses.
	tr := tracker.WrapBatching(fo)

	res, err := runner.Run(context.Background(), runner.Options{
		OrcaPath:       orca,
		InputPath:      input,
		ExperimentName: "exp",
		RunName:        "h2",
		SysInterval:    time.Hour,
		ArtifactLevel:  levels.ArtifactsEssential,
		Tracker:        tr,
		Stdout:         io.Discard,
		Stderr:         io.Discard,
	})
	if err != nil {
		t.Fatalf("offline Run returned error: %v", err)
	}
	if res.ExitCode != 0 {
		t.Fatalf("ORCA exit code = %d, want 0 — chemistry must not depend on the network", res.ExitCode)
	}
	if !spool.IsLocalID(string(res.RunID)) {
		t.Fatalf("offline run id = %q, want a journal-local id", res.RunID)
	}
	closeCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := tr.Close(closeCtx); err != nil {
		t.Fatalf("Close: %v", err)
	}

	journalDir, ok := fo.Journaled()
	if !ok {
		t.Fatal("offline run left no journal")
	}
	j, err := spool.Load(journalDir)
	if err != nil {
		t.Fatalf("Load journal: %v", err)
	}
	if j.Tail != nil {
		t.Fatalf("journal tail damaged: %v", j.Tail)
	}

	// The journal must carry the run's whole story, in order: experiment,
	// run creation, running status, streamed data, final status, artifacts.
	var kinds []spool.OpKind
	for _, rec := range j.Ops {
		kinds = append(kinds, rec.Op)
	}
	mustContainInOrder(t, kinds,
		spool.OpEnsureExperiment, spool.OpCreateRun, spool.OpUpdateStatus)
	if !containsOp(kinds, spool.OpAppendMetrics) && !containsOp(kinds, spool.OpAppendEvents) {
		t.Fatalf("no streamed data journaled; ops: %v", kinds)
	}
	if !containsOp(kinds, spool.OpSetArtifacts) {
		t.Fatalf("no artifacts journaled; ops: %v", kinds)
	}
	// Final status update must record the finish.
	var finished bool
	for _, rec := range j.Ops {
		if rec.Op == spool.OpUpdateStatus && rec.Payload.Status != nil &&
			rec.Payload.Status.Status == tracker.StatusFinished {
			finished = true
			if rec.Payload.Status.LastEnergy == nil || *rec.Payload.Status.LastEnergy != -2.5 {
				t.Fatalf("final status lost the energy: %+v", rec.Payload.Status)
			}
		}
	}
	if !finished {
		t.Fatalf("no finished status journaled; ops: %v", kinds)
	}

	// And the whole journal replays cleanly, in order, against a backend.
	fr := newE2EReplayer()
	sum, err := spool.Replay(context.Background(), j, fr)
	if err != nil {
		t.Fatalf("Replay: %v", err)
	}
	if sum.Applied != len(j.Ops) {
		t.Fatalf("replayed %d of %d ops", sum.Applied, len(j.Ops))
	}
	if fr.createdRuns != 1 {
		t.Fatalf("replay created %d runs, want 1", fr.createdRuns)
	}
}

func containsOp(kinds []spool.OpKind, want spool.OpKind) bool {
	for _, k := range kinds {
		if k == want {
			return true
		}
	}
	return false
}

func mustContainInOrder(t *testing.T, kinds []spool.OpKind, want ...spool.OpKind) {
	t.Helper()
	i := 0
	for _, k := range kinds {
		if i < len(want) && k == want[i] {
			i++
		}
	}
	if i != len(want) {
		t.Fatalf("ops %v do not contain %v in order", kinds, want)
	}
}

// e2eReplayer is a minimal SpoolReplayer for the end-to-end test.
type e2eReplayer struct {
	createdRuns int
}

func newE2EReplayer() *e2eReplayer { return &e2eReplayer{} }

func (r *e2eReplayer) SpoolCreateRun(context.Context, string, tracker.RunCreate) (tracker.RunID, error) {
	r.createdRuns++
	return "backend-run", nil
}
func (r *e2eReplayer) SpoolAppendEvents(context.Context, string, tracker.RunID, []tracker.Event) error {
	return nil
}
func (r *e2eReplayer) SpoolAppendMetrics(context.Context, string, tracker.RunID, []tracker.Metric) error {
	return nil
}
func (r *e2eReplayer) SpoolAppendLogs(context.Context, string, tracker.RunID, []tracker.LogEntry) error {
	return nil
}
func (r *e2eReplayer) SpoolAppendSysSamples(context.Context, string, tracker.RunID, []tracker.SysSample) error {
	return nil
}
func (r *e2eReplayer) EnsureExperiment(context.Context, string, string) (tracker.ExperimentID, error) {
	return "backend-exp", nil
}
func (r *e2eReplayer) EnsureBatch(context.Context, tracker.ExperimentID, string, levels.ArtifactLevel) (tracker.BatchID, error) {
	return "backend-batch", nil
}
func (r *e2eReplayer) UpdateRunStatus(context.Context, tracker.RunID, tracker.StatusUpdate) error {
	return nil
}
func (r *e2eReplayer) AppendGeometry(context.Context, tracker.RunID, int, string) error { return nil }
func (r *e2eReplayer) SetFrequencies(context.Context, tracker.RunID, []tracker.Frequency) error {
	return nil
}
func (r *e2eReplayer) SetExcitedStates(context.Context, tracker.RunID, []tracker.ExcitedState) error {
	return nil
}
func (r *e2eReplayer) SetNMRShields(context.Context, tracker.RunID, []tracker.NMRShield) error {
	return nil
}
func (r *e2eReplayer) SetArtifacts(context.Context, tracker.RunID, []tracker.Artifact) error {
	return nil
}
func (r *e2eReplayer) UpsertArtifacts(context.Context, tracker.RunID, []tracker.Artifact) error {
	return nil
}

var _ tracker.SpoolReplayer = (*e2eReplayer)(nil)
