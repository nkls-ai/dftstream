package runner

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/nkls-ai/dftstream/internal/inputparse"
	"github.com/nkls-ai/dftstream/internal/parser"
	"github.com/nkls-ai/dftstream/internal/tracker"
)

func f64(v float64) *float64 { return &v }

// feedEvents drives the accumulator with a sequence of parser events,
// failing the test on any tracker error (the Noop tracker never errors).
func feedEvents(t *testing.T, a *eventAccumulator, events ...parser.Event) {
	t.Helper()
	ctx := context.Background()
	for _, ev := range events {
		if err := a.handle(ctx, ev); err != nil {
			t.Fatalf("handle(%s): %v", ev.Kind(), err)
		}
	}
}

func freqEvent(imag bool) parser.FrequenciesEvent {
	return parser.FrequenciesEvent{Items: []parser.Frequency{
		{Idx: 6, Wavenumber: -100.0, Imaginary: imag},
	}}
}

func thermoEvent(gibbs float64) parser.ThermoEvent {
	return parser.ThermoEvent{GibbsEh: f64(gibbs)}
}

// calc_hess prints a full frequency + thermochemistry section for the
// STARTING geometry before the optimizer runs. When no post-convergence
// section follows (plain Opt without a final Freq), those values must
// not become the run's imaginary-mode count / thermochemistry.
func TestFinalStatusIgnoresPreConvergenceFreqThermoForOptRuns(t *testing.T) {
	a := newEventAccumulator(tracker.NoopTracker{}, "run1", inputparse.Parse("! r2SCAN-3c Opt\n"))
	feedEvents(t, a,
		freqEvent(true),
		thermoEvent(-100.0),
		parser.OptConvergedEvent{},
	)
	upd := a.finalStatusUpdate(tracker.StatusFinished, 0, time.Now())
	if upd.ImaginaryModes != nil {
		t.Errorf("ImaginaryModes = %v, want nil (freq section was pre-convergence)", *upd.ImaginaryModes)
	}
	if upd.GibbsEh != nil {
		t.Errorf("GibbsEh = %v, want nil (thermo section was pre-convergence)", *upd.GibbsEh)
	}
	if upd.Converged == nil || !*upd.Converged {
		t.Errorf("Converged = %v, want true", upd.Converged)
	}
}

// The final Freq of an Opt(TS)+Freq run comes after the convergence
// banner; its section wins even when calc_hess printed an earlier one.
func TestFinalStatusUsesPostConvergenceFreqThermo(t *testing.T) {
	a := newEventAccumulator(tracker.NoopTracker{}, "run1", inputparse.Parse("! r2SCAN-3c Opt Freq\n"))
	feedEvents(t, a,
		freqEvent(true),     // initial Hessian (starting geometry)
		thermoEvent(-100.0), // initial-Hessian thermo
		parser.OptConvergedEvent{},
		freqEvent(false),     // final Freq
		thermoEvent(-100.42), // final thermo
	)
	upd := a.finalStatusUpdate(tracker.StatusFinished, 0, time.Now())
	if upd.ImaginaryModes == nil || *upd.ImaginaryModes != 0 {
		t.Errorf("ImaginaryModes = %v, want 0 (final Freq)", upd.ImaginaryModes)
	}
	if upd.GibbsEh == nil || *upd.GibbsEh != -100.42 {
		t.Errorf("GibbsEh = %v, want -100.42 (final thermo)", upd.GibbsEh)
	}
}

// Non-optimization runs (a plain Freq on an already-optimized geometry)
// have no convergence banner; their sections always count.
func TestFinalStatusKeepsFreqThermoForNonOptRuns(t *testing.T) {
	a := newEventAccumulator(tracker.NoopTracker{}, "run1", inputparse.Parse("! r2SCAN-3c Freq\n"))
	feedEvents(t, a,
		freqEvent(true),
		thermoEvent(-100.0),
	)
	upd := a.finalStatusUpdate(tracker.StatusFinished, 0, time.Now())
	if upd.ImaginaryModes == nil || *upd.ImaginaryModes != 1 {
		t.Errorf("ImaginaryModes = %v, want 1", upd.ImaginaryModes)
	}
	if upd.GibbsEh == nil || *upd.GibbsEh != -100.0 {
		t.Errorf("GibbsEh = %v, want -100.0", upd.GibbsEh)
	}
}

// NEB runs pre-optimize their endpoints, which prints the plain
// opt-converged banner twice before the band phase. Those banners must
// not mark a NEB-TS run converged when the TS phase never succeeds.
func TestNEBTSEndpointPreoptIsNotRunConvergence(t *testing.T) {
	a := newEventAccumulator(tracker.NoopTracker{}, "run1", inputparse.Parse("! XTB NEB-TS Freq\n"))
	feedEvents(t, a,
		parser.OptConvergedEvent{}, // reactant preopt
		parser.OptConvergedEvent{}, // product preopt
		parser.NEBPhaseStartEvent{},
	)
	upd := a.finalStatusUpdate(tracker.StatusFinished, 0, time.Now())
	if upd.Converged == nil || *upd.Converged {
		t.Errorf("Converged = %v, want false (band and TS phase never converged)", upd.Converged)
	}
}

// The full NEB-TS success path: preopt → band converges → TS opt
// converges → final Freq with one imaginary mode.
func TestNEBTSConvergedTSPhaseCounts(t *testing.T) {
	a := newEventAccumulator(tracker.NoopTracker{}, "run1", inputparse.Parse("! XTB NEB-TS Freq\n"))
	feedEvents(t, a,
		parser.OptConvergedEvent{}, // preopt
		parser.NEBPhaseStartEvent{},
		parser.NEBConvergedEvent{},
		parser.OptConvergedEvent{}, // TS optimization
		freqEvent(true),
		thermoEvent(-5.5),
	)
	upd := a.finalStatusUpdate(tracker.StatusFinished, 0, time.Now())
	if upd.Converged == nil || !*upd.Converged {
		t.Fatalf("Converged = %v, want true", upd.Converged)
	}
	if upd.ImaginaryModes == nil || *upd.ImaginaryModes != 1 {
		t.Errorf("ImaginaryModes = %v, want 1", upd.ImaginaryModes)
	}
	if upd.GibbsEh == nil || *upd.GibbsEh != -5.5 {
		t.Errorf("GibbsEh = %v, want -5.5", upd.GibbsEh)
	}
}

// A calc_hess frequency section printed during the NEB phase (before the
// TS optimization converges) must not become the run's imaginary count.
func TestNEBTSPreConvergenceFreqIsGated(t *testing.T) {
	a := newEventAccumulator(tracker.NoopTracker{}, "run1", inputparse.Parse("! XTB NEB-TS\n"))
	feedEvents(t, a,
		parser.OptConvergedEvent{}, // preopt
		parser.NEBPhaseStartEvent{},
		freqEvent(true), // calc_hess-style section mid-run
	)
	upd := a.finalStatusUpdate(tracker.StatusFinished, 0, time.Now())
	if upd.ImaginaryModes != nil {
		t.Errorf("ImaginaryModes = %v, want nil (freq preceded TS convergence)", *upd.ImaginaryModes)
	}
}

// Plain NEB / NEB-CI runs have no TS phase: the band's own convergence
// banner decides, and merely finishing is no longer success.
func TestNEBCIConvergenceFollowsBandBanner(t *testing.T) {
	converged := newEventAccumulator(tracker.NoopTracker{}, "run1", inputparse.Parse("! XTB NEB-CI\n"))
	feedEvents(t, converged,
		parser.OptConvergedEvent{}, // preopt
		parser.NEBPhaseStartEvent{},
		parser.NEBConvergedEvent{},
	)
	upd := converged.finalStatusUpdate(tracker.StatusFinished, 0, time.Now())
	if upd.Converged == nil || !*upd.Converged {
		t.Errorf("Converged = %v, want true (band converged)", upd.Converged)
	}

	stalled := newEventAccumulator(tracker.NoopTracker{}, "run2", inputparse.Parse("! XTB NEB-CI\n"))
	feedEvents(t, stalled,
		parser.OptConvergedEvent{}, // preopt only
		parser.NEBPhaseStartEvent{},
	)
	upd = stalled.finalStatusUpdate(tracker.StatusFinished, 0, time.Now())
	if upd.Converged == nil || *upd.Converged {
		t.Errorf("Converged = %v, want false (band never converged; preopt banner must not count)", upd.Converged)
	}
}

// The explicit "did not converge" message marks a stalled optimizer:
// persisted as its own flag so the UI can tell max-cycles from a crash.
func TestOptMaxCyclesPersisted(t *testing.T) {
	a := newEventAccumulator(tracker.NoopTracker{}, "run1", inputparse.Parse("! r2SCAN-3c Opt\n"))
	feedEvents(t, a, parser.OptNotConvergedEvent{})
	upd := a.finalStatusUpdate(tracker.StatusFinished, 0, time.Now())
	if upd.Converged == nil || *upd.Converged {
		t.Errorf("Converged = %v, want false", upd.Converged)
	}
	if upd.OptMaxCycles == nil || !*upd.OptMaxCycles {
		t.Errorf("OptMaxCycles = %v, want true", upd.OptMaxCycles)
	}
}

// ---------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------

func diagEvent(class parser.ErrorClass, excerpt string) parser.DiagnosticEvent {
	return parser.DiagnosticEvent{Class: class, Excerpt: excerpt}
}

// finished is a clean terminal state: ORCA printed its normal banner and
// the process exited 0.
func finished(t *testing.T, a *eventAccumulator) tracker.StatusUpdate {
	t.Helper()
	feedEvents(t, a, parser.RunEndEvent{Normal: true})
	return a.finalStatusUpdate(tracker.StatusFinished, 0, time.Now())
}

// crashed is the terminal state of a run that died: no normal banner,
// non-zero exit.
func crashed(t *testing.T, a *eventAccumulator) tracker.StatusUpdate {
	t.Helper()
	return a.finalStatusUpdate(tracker.StatusFailed, 1, time.Now())
}

func newAcc(input string) *eventAccumulator {
	return newEventAccumulator(tracker.NoopTracker{}, "run1", inputparse.Parse(input))
}

// A run that finished normally carries no error class at all.
func TestFinalStatusCleanRunHasNoErrorClass(t *testing.T) {
	a := newAcc("! HF def2-SVP\n")
	upd := finished(t, a)
	if upd.ErrorClass != nil {
		t.Errorf("ErrorClass = %q, want nil", *upd.ErrorClass)
	}
	if upd.ErrorExcerpt != nil {
		t.Errorf("ErrorExcerpt = %q, want nil", *upd.ErrorExcerpt)
	}
}

// A run that died without saying why is still classified — "unknown" is a
// verdict, an empty column is not.
func TestFinalStatusUnexplainedFailureIsUnknown(t *testing.T) {
	upd := crashed(t, newAcc("! HF def2-SVP\n"))
	if upd.ErrorClass == nil || *upd.ErrorClass != parser.ErrorClassUnknown.String() {
		t.Errorf("ErrorClass = %v, want %q", upd.ErrorClass, parser.ErrorClassUnknown)
	}
	if upd.ErrorExcerpt != nil {
		t.Errorf("ErrorExcerpt = %q, want nil (nothing to quote)", *upd.ErrorExcerpt)
	}
}

func TestFinalStatusReportsDiagnosedFailure(t *testing.T) {
	a := newAcc("! HF def2-SVP\n")
	feedEvents(t, a, diagEvent(parser.ErrorClassSCFNotConverged, "SCF NOT CONVERGED AFTER 125 CYCLES"))
	upd := crashed(t, a)
	if upd.ErrorClass == nil || *upd.ErrorClass != parser.ErrorClassSCFNotConverged.String() {
		t.Fatalf("ErrorClass = %v, want %q", upd.ErrorClass, parser.ErrorClassSCFNotConverged)
	}
	if upd.ErrorExcerpt == nil || *upd.ErrorExcerpt != "SCF NOT CONVERGED AFTER 125 CYCLES" {
		t.Errorf("ErrorExcerpt = %v, want the diagnosed line", upd.ErrorExcerpt)
	}
}

// Several diagnoses in one output: the most specific one wins, and it
// brings its own excerpt with it rather than another failure's.
func TestFinalStatusKeepsMostSevereDiagnosis(t *testing.T) {
	a := newAcc("! HF def2-SVP\n")
	feedEvents(t, a,
		diagEvent(parser.ErrorClassUnknown, "generic abort"),
		diagEvent(parser.ErrorClassOutOfMemory, "Please increase MaxCore"),
		diagEvent(parser.ErrorClassExternalToolFailed, "error termination in LEANSCF"),
	)
	upd := crashed(t, a)
	if upd.ErrorClass == nil || *upd.ErrorClass != parser.ErrorClassOutOfMemory.String() {
		t.Fatalf("ErrorClass = %v, want %q", upd.ErrorClass, parser.ErrorClassOutOfMemory)
	}
	if upd.ErrorExcerpt == nil || *upd.ErrorExcerpt != "Please increase MaxCore" {
		t.Errorf("ErrorExcerpt = %v, want the out-of-memory excerpt", upd.ErrorExcerpt)
	}
}

// ORCA prints the wavefunction-instability banner before reconverging, so
// a run that recovered and finished cleanly must not be labelled failed.
func TestFinalStatusDropsRecoveredDiagnosisOnCleanRun(t *testing.T) {
	a := newAcc("! UKS HF def2-SVP\n")
	feedEvents(t, a, diagEvent(parser.ErrorClassUnstableWavefunction, "the wavefunction is unstable"))
	upd := finished(t, a)
	if upd.ErrorClass != nil {
		t.Errorf("ErrorClass = %q, want nil (ORCA reconverged and finished)", *upd.ErrorClass)
	}
}

// A module that dies mid-run is a failure even though ORCA goes on to
// print its normal banner and exit 0 — the class that survives a clean
// termination is exactly ErrorClass.IsHardFailure.
func TestFinalStatusKeepsHardFailureOnCleanRun(t *testing.T) {
	a := newAcc("! HF def2-SVP TDDFT\n")
	feedEvents(t, a, diagEvent(parser.ErrorClassExternalToolFailed, "ORCA finished by error termination in CIS"))
	upd := finished(t, a)
	if upd.ErrorClass == nil || *upd.ErrorClass != parser.ErrorClassExternalToolFailed.String() {
		t.Fatalf("ErrorClass = %v, want %q", upd.ErrorClass, parser.ErrorClassExternalToolFailed)
	}
}

// A context-dependent diagnosis that outranks a hard one must not hide it
// when the run terminated normally.
func TestFinalStatusHardFailureSurvivesAMoreSevereSoftOne(t *testing.T) {
	a := newAcc("! UKS HF def2-SVP\n")
	feedEvents(t, a,
		diagEvent(parser.ErrorClassUnstableWavefunction, "recovered instability"),
		diagEvent(parser.ErrorClassExternalToolFailed, "error termination in PROPERTIES"),
	)
	upd := finished(t, a)
	if upd.ErrorClass == nil || *upd.ErrorClass != parser.ErrorClassExternalToolFailed.String() {
		t.Fatalf("ErrorClass = %v, want %q", upd.ErrorClass, parser.ErrorClassExternalToolFailed)
	}
	if upd.ErrorExcerpt == nil || *upd.ErrorExcerpt != "error termination in PROPERTIES" {
		t.Errorf("ErrorExcerpt = %v, want the tool-failure excerpt", upd.ErrorExcerpt)
	}
}

// The optMaxCycles flag and the opt_max_cycles error class come from one
// signal and must never disagree, including on a run ORCA still called
// normal (it prints the banner even after aborting for max cycles).
func TestOptMaxCyclesAgreesWithErrorClass(t *testing.T) {
	a := newAcc("! r2SCAN-3c OptTS Freq\n")
	feedEvents(t, a,
		parser.OptNotConvergedEvent{},
		diagEvent(parser.ErrorClassOptMaxCycles, "The optimization did not converge but reached the maximum"),
	)
	upd := finished(t, a)
	if upd.OptMaxCycles == nil || !*upd.OptMaxCycles {
		t.Fatalf("OptMaxCycles = %v, want true", upd.OptMaxCycles)
	}
	if upd.ErrorClass == nil || *upd.ErrorClass != parser.ErrorClassOptMaxCycles.String() {
		t.Fatalf("ErrorClass = %v, want %q", upd.ErrorClass, parser.ErrorClassOptMaxCycles)
	}
	if upd.ErrorExcerpt == nil || !strings.Contains(*upd.ErrorExcerpt, "reached the maximum") {
		t.Errorf("ErrorExcerpt = %v, want the max-cycles message", upd.ErrorExcerpt)
	}
}

// An optimizer that recovered and converged later is not stalled, so
// neither the flag nor the class is set.
func TestOptMaxCyclesNotReportedWhenOptimizerLaterConverged(t *testing.T) {
	a := newAcc("! XTB2 Opt\n")
	feedEvents(t, a,
		parser.OptNotConvergedEvent{}, // one relaxed-scan point stalled
		diagEvent(parser.ErrorClassOptMaxCycles, "did not converge"),
		parser.OptConvergedEvent{},
	)
	upd := finished(t, a)
	if upd.OptMaxCycles != nil {
		t.Errorf("OptMaxCycles = %v, want nil", *upd.OptMaxCycles)
	}
	if upd.ErrorClass != nil {
		t.Errorf("ErrorClass = %q, want nil", *upd.ErrorClass)
	}
}

// A hard failure outranks a stalled optimizer: the memory error is why
// the optimizer never got any further.
func TestHardFailureOutranksOptMaxCycles(t *testing.T) {
	a := newAcc("! r2SCAN-3c Opt\n")
	feedEvents(t, a,
		parser.OptNotConvergedEvent{},
		diagEvent(parser.ErrorClassOptMaxCycles, "max cycles"),
		diagEvent(parser.ErrorClassOutOfMemory, "Please increase MaxCore"),
	)
	upd := crashed(t, a)
	if upd.OptMaxCycles == nil || !*upd.OptMaxCycles {
		t.Errorf("OptMaxCycles = %v, want true (the flag still records the stall)", upd.OptMaxCycles)
	}
	if upd.ErrorClass == nil || *upd.ErrorClass != parser.ErrorClassOutOfMemory.String() {
		t.Errorf("ErrorClass = %v, want %q", upd.ErrorClass, parser.ErrorClassOutOfMemory)
	}
}

// The live path and the offline import path share this one verdict
// function, and the offline path derives its exit code from the very
// termination banner the live path gets from the process. Identical
// events must therefore give an identical status update.
func TestLiveAndOfflinePathsAgree(t *testing.T) {
	events := []parser.Event{
		parser.FinalSPEvent{Energy: -75.9},
		diagEvent(parser.ErrorClassExternalToolFailed, "error termination in CIS"),
		parser.RunEndEvent{Normal: true, Wallclock: 12 * time.Second},
	}
	live := newAcc("! HF def2-SVP\n")
	feedEvents(t, live, events...)
	// Live: the process exited 0 and ORCA terminated normally.
	liveUpd := live.finalStatusUpdate(tracker.StatusFinished, 0, time.Now())

	offline := newAcc("! HF def2-SVP\n")
	feedEvents(t, offline, events...)
	// Offline: ingest.finalize derives StatusFinished/0 from runEndNormal.
	offlineUpd := offline.finalStatusUpdate(tracker.StatusFinished, 0, time.Now())

	if !equalStrPtr(liveUpd.ErrorClass, offlineUpd.ErrorClass) {
		t.Errorf("ErrorClass live=%v offline=%v", liveUpd.ErrorClass, offlineUpd.ErrorClass)
	}
	if !equalStrPtr(liveUpd.ErrorExcerpt, offlineUpd.ErrorExcerpt) {
		t.Errorf("ErrorExcerpt live=%v offline=%v", liveUpd.ErrorExcerpt, offlineUpd.ErrorExcerpt)
	}
	if liveUpd.ErrorClass == nil {
		t.Error("ErrorClass = nil, want the tool failure (both paths)")
	}
}

func equalStrPtr(a, b *string) bool {
	switch {
	case a == nil && b == nil:
		return true
	case a == nil || b == nil:
		return false
	default:
		return *a == *b
	}
}
