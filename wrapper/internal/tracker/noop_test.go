package tracker

import (
	"context"
	"testing"
	"time"

	"github.com/nkls-ai/dftstream/internal/levels"
)

func TestNoopTrackerSatisfiesInterface(t *testing.T) {
	var tr Tracker = NewNoopTracker()

	ctx := context.Background()
	expID, err := tr.EnsureExperiment(ctx, "", "test")
	if err != nil {
		t.Fatal(err)
	}
	if expID == "" {
		t.Fatal("expected non-empty experiment ID from noop tracker")
	}
	batchID, err := tr.EnsureBatch(ctx, expID, "batch", levels.ArtifactsIO)
	if err != nil {
		t.Fatal(err)
	}
	if batchID == "" {
		t.Fatal("expected non-empty batch ID from noop tracker")
	}

	runID, err := tr.CreateRun(ctx, RunCreate{ExperimentID: expID, BatchID: batchID, Name: "run"})
	if err != nil {
		t.Fatal(err)
	}
	if runID == "" {
		t.Fatal("expected non-empty run ID from noop tracker")
	}

	if err := tr.UpdateRunStatus(ctx, runID, StatusUpdate{Status: StatusRunning}); err != nil {
		t.Fatal(err)
	}
	if err := tr.AppendEvent(ctx, runID, Event{Seq: 1, Kind: "test"}); err != nil {
		t.Fatal(err)
	}
	if err := tr.AppendMetric(ctx, runID, Metric{Key: "e", Value: -1.0}); err != nil {
		t.Fatal(err)
	}
	if err := tr.AppendGeometry(ctx, runID, 1, "2\n\nH 0 0 0\nH 0 0 1\n"); err != nil {
		t.Fatal(err)
	}
	if err := tr.SetFrequencies(ctx, runID, []Frequency{{Idx: 0, Wavenumber: 100}}); err != nil {
		t.Fatal(err)
	}
	if err := tr.AppendSysSample(ctx, runID, SysSample{TS: time.Now(), CPUPct: 50}); err != nil {
		t.Fatal(err)
	}
	if err := tr.SetArtifacts(ctx, runID, nil); err != nil {
		t.Fatal(err)
	}
	if err := tr.AppendArtifacts(ctx, runID, nil); err != nil {
		t.Fatal(err)
	}
	if err := tr.AppendLogs(ctx, runID, []LogEntry{{Level: "info", Message: "test"}}); err != nil {
		t.Fatal(err)
	}
	foundID, err := tr.FindRunByName(ctx, expID, "run")
	if err != nil {
		t.Fatal(err)
	}
	if foundID != "" {
		t.Fatalf("expected empty from noop FindRunByName, got %q", foundID)
	}
	if err := tr.Close(ctx); err != nil {
		t.Fatal(err)
	}
}
