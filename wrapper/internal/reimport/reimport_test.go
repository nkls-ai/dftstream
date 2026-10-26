package reimport

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The parser regression fixture of the exact failure P0-5 exists for: an Opt
// that hit its cycle limit while ORCA still printed "TERMINATED NORMALLY".
// Old wrappers stored such runs as converged=true.
const stalledOptFixture = "orca6_opt_max_cycles.out"

func fixtureText(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "parser", "testdata", name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return string(b)
}

func stalledOptRun(t *testing.T, stored Fields) Run {
	t.Helper()
	exit := 0.0
	return Run{
		ID:        "run-1",
		Name:      "opt-1",
		Status:    "finished",
		ExitCode:  &exit,
		InputText: "! r2SCAN-3c Opt\n%maxcore 4000\n* xyz 0 1\nO 0.0 0.0 0.0\n*\n",
		Fields:    stored,
	}
}

func recomputeStalledOpt(t *testing.T, stored Fields) Fields {
	t.Helper()
	run := stalledOptRun(t, stored)
	fresh, err := Recompute(context.Background(), run, strings.NewReader(fixtureText(t, stalledOptFixture)))
	if err != nil {
		t.Fatalf("Recompute: %v", err)
	}
	return fresh
}

func TestRecomputeStalledOptVerdict(t *testing.T) {
	fresh := recomputeStalledOpt(t, Fields{})
	if fresh.Converged == nil || *fresh.Converged {
		t.Errorf("Converged = %v, want false (opt stalled at max cycles)", fresh.Converged)
	}
	if fresh.OptMaxCycles == nil || !*fresh.OptMaxCycles {
		t.Errorf("OptMaxCycles = %v, want true", fresh.OptMaxCycles)
	}
	if fresh.ErrorClass == nil || *fresh.ErrorClass != "opt_max_cycles" {
		t.Errorf("ErrorClass = %v, want opt_max_cycles", fresh.ErrorClass)
	}
	if fresh.LastEnergy == nil || *fresh.LastEnergy != -75.955 {
		t.Errorf("LastEnergy = %v, want -75.955", fresh.LastEnergy)
	}
	if fresh.WallclockSec == nil || *fresh.WallclockSec != 12.5 {
		t.Errorf("WallclockSec = %v, want 12.5", fresh.WallclockSec)
	}
	if fresh.ImaginaryModes != nil {
		t.Errorf("ImaginaryModes = %v, want absent (no freq section)", *fresh.ImaginaryModes)
	}
}

// The historical bug: converged=true stored for a stalled opt, plus stale
// thermo the phase-aware parser now rejects. Diff must correct the verdicts
// and CLEAR the thermo (Wire == nil → JSON null → field removed).
func TestDiffRepairsHistoricalBadVerdict(t *testing.T) {
	badTrue := true
	staleGibbs := -76.01
	stored := Fields{Converged: &badTrue, GibbsEh: &staleGibbs}
	fresh := recomputeStalledOpt(t, stored)

	changes := Diff(stored, fresh)
	byField := map[string]Change{}
	for _, c := range changes {
		byField[c.Field] = c
	}
	if c, ok := byField["converged"]; !ok || c.Old != "true" || c.New != "false" || c.Wire != false {
		t.Errorf("converged change = %+v, ok=%v; want true → false", byField["converged"], ok)
	}
	if c, ok := byField["optMaxCycles"]; !ok || c.Wire != true {
		t.Errorf("optMaxCycles change = %+v, ok=%v; want set to true", c, ok)
	}
	if c, ok := byField["errorClass"]; !ok || c.Wire != "opt_max_cycles" {
		t.Errorf("errorClass change = %+v, ok=%v; want opt_max_cycles", c, ok)
	}
	if c, ok := byField["gibbsEh"]; !ok || c.Wire != nil || c.New != "—" {
		t.Errorf("gibbsEh change = %+v, ok=%v; want a clear (Wire nil)", c, ok)
	}

	// Patch encodes the clear as an explicit JSON null on the wire.
	wire, err := json.Marshal(Patch(changes))
	if err != nil {
		t.Fatalf("marshal patch: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(wire, &decoded); err != nil {
		t.Fatalf("unmarshal patch: %v", err)
	}
	if v, present := decoded["gibbsEh"]; !present || v != nil {
		t.Errorf("patch gibbsEh = %v (present=%v), want explicit null", v, present)
	}
}

// Idempotency: once the stored row matches the current parser, a second sweep
// finds nothing — Diff of a recompute against itself is empty, and so is Diff
// after simulating the patch application.
func TestDiffIdempotent(t *testing.T) {
	badTrue := true
	staleGibbs := -76.01
	stored := Fields{Converged: &badTrue, GibbsEh: &staleGibbs}
	fresh := recomputeStalledOpt(t, stored)

	if d := Diff(fresh, fresh); len(d) != 0 {
		t.Errorf("Diff(fresh, fresh) = %v, want empty", d)
	}

	// Second run of the sweep: the stored row is now what --fix wrote.
	if d := Diff(fresh, recomputeStalledOpt(t, fresh)); len(d) != 0 {
		t.Errorf("second sweep found drift: %v, want none", d)
	}
}

// Measurements are never erased: a stored lastEnergy/wallclock survives even
// when the re-parse cannot reproduce it (e.g. a truncated local copy).
func TestDiffNeverClearsMeasurements(t *testing.T) {
	e := -1.5
	w := 3.25
	stored := Fields{LastEnergy: &e, WallclockSec: &w}
	fresh := Fields{} // re-parse yielded neither
	if d := Diff(stored, fresh); len(d) != 0 {
		t.Errorf("Diff cleared measurements: %v, want no changes", d)
	}
	// But a *different* recomputed value does win.
	e2 := -2.5
	fresh.LastEnergy = &e2
	d := Diff(stored, fresh)
	if len(d) != 1 || d[0].Field != "lastEnergy" || d[0].Wire != -2.5 {
		t.Errorf("Diff = %v, want exactly one lastEnergy update to -2.5", d)
	}
}

func TestRunHelpers(t *testing.T) {
	run := Run{Status: "finished"}
	if !run.Terminal() || run.EffectiveExitCode() != 0 {
		t.Errorf("finished run: Terminal=%v exit=%d, want true/0", run.Terminal(), run.EffectiveExitCode())
	}
	run.Status = "failed"
	if !run.Terminal() || run.EffectiveExitCode() != 1 {
		t.Errorf("failed run: Terminal=%v exit=%d, want true/1", run.Terminal(), run.EffectiveExitCode())
	}
	code := 137.0
	run.ExitCode = &code
	if run.EffectiveExitCode() != 137 {
		t.Errorf("stored exit code not honored: got %d", run.EffectiveExitCode())
	}
	run.Status = "running"
	if run.Terminal() {
		t.Error("running run reported terminal")
	}
}

func TestUnmarshalRow(t *testing.T) {
	raw := json.RawMessage(`{
		"_id": "abc",
		"name": "opt-1",
		"status": "finished",
		"exitCode": 0,
		"startedAt": 1000,
		"inputText": "! Opt\n",
		"converged": true,
		"gibbsEh": -76.01
	}`)
	var run Run
	if err := run.UnmarshalRow(raw); err != nil {
		t.Fatalf("UnmarshalRow: %v", err)
	}
	if run.ID != "abc" || run.Name != "opt-1" {
		t.Errorf("identity fields wrong: %+v", run)
	}
	if run.Converged == nil || !*run.Converged {
		t.Errorf("embedded Fields not decoded: converged=%v", run.Converged)
	}
	if run.GibbsEh == nil || *run.GibbsEh != -76.01 {
		t.Errorf("embedded Fields not decoded: gibbsEh=%v", run.GibbsEh)
	}
	var empty Run
	if err := empty.UnmarshalRow(json.RawMessage(`{}`)); err == nil {
		t.Error("UnmarshalRow accepted a row without _id")
	}
}
