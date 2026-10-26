package runner

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/nkls-ai/dftstream/internal/inputparse"
	"github.com/nkls-ai/dftstream/internal/parser"
	"github.com/nkls-ai/dftstream/internal/tracker"
)

// eventAccumulator folds parser events into tracker writes and keeps the
// run-level aggregates (last energy, convergence, imaginary modes,
// thermochemistry, wallclock) needed to build the final status update.
// Shared by the live runner and the offline ingest path so the
// final-status derivation cannot drift between them.
//
// Aggregates use atomics because the live runner writes them from the
// event pump goroutine and reads them from the main goroutine after the
// pump drains.
type eventAccumulator struct {
	tracker tracker.Tracker
	runID   tracker.RunID

	// summary of the parsed input; run-type semantics (opt vs NEB band
	// vs plain) decide how events fold into the final status.
	summary inputparse.Summary
	// nebBand caches summary.RequestsNEBBand(): endpoint pre-optimizations
	// inside NEB runs print the plain opt-converged banner before the band
	// phase and must not count as run convergence.
	nebBand bool

	seq            int64
	lastEnergy     atomic.Value // float64
	wallclockSec   atomic.Value // float64 — populated by RunEndEvent
	optConverged   atomic.Bool
	optMaxCycles   atomic.Bool // optimizer stopped at max cycles (explicit ORCA message)
	nebStarted     atomic.Bool
	nebConverged   atomic.Bool
	imaginaryModes atomic.Int32 // -1 = unknown (no freq event seen)
	thermo         atomic.Value // parser.ThermoEvent — last section wins
	runEndNormal   atomic.Bool

	spin atomic.Value // parser.SpinContaminationEvent — last SCF wins

	// Failure diagnosis. diagMu guards the pair because the class and its
	// excerpt must be replaced together; a torn update would attach one
	// failure's excerpt to another's class. opt_max_cycles is kept apart
	// because whether it counts is decided in finalStatusUpdate, by the
	// same gate that fills OptMaxCycles.
	// hardClass tracks the most severe self-standing failure separately,
	// so a context-dependent diagnosis that outranks it (an instability
	// ORCA recovered from) cannot hide it on a run that terminated
	// normally.
	diagMu           sync.Mutex
	diagClass        parser.ErrorClass
	diagExcerpt      string
	hardClass        parser.ErrorClass
	hardExcerpt      string
	optCyclesExcerpt string

	// Whether the LAST freq/thermo section arrived after the optimizer
	// converged. calc_hess (and recalc_hess) print full frequency +
	// thermochemistry sections for the STARTING geometry before the
	// optimization; those must not become the run's imaginary-mode count
	// or thermochemistry when no post-convergence section follows.
	freqPostConv   atomic.Bool
	thermoPostConv atomic.Bool
}

func newEventAccumulator(tr tracker.Tracker, runID tracker.RunID, summary inputparse.Summary) *eventAccumulator {
	a := &eventAccumulator{tracker: tr, runID: runID, summary: summary, nebBand: summary.RequestsNEBBand()}
	a.imaginaryModes.Store(-1)
	return a
}

// handle records one parser event: it assigns the sequence number and
// dispatches to the per-event method that appends the event row, derived
// metrics and section results to the tracker and updates the run-level
// aggregates. Individual tracker failures are joined so one bad write
// never hides the rest.
func (a *eventAccumulator) handle(ctx context.Context, ev parser.Event) error {
	a.seq++
	switch e := ev.(type) {
	case parser.ScfIterEvent:
		return a.onScfIter(ctx, e)
	case parser.ScfConvergedEvent:
		return a.onScfConverged(ctx, e)
	case parser.TotalEnergyEvent:
		return a.onTotalEnergy(ctx, e)
	case parser.FinalSPEvent:
		return a.onFinalSP(ctx, e)
	case parser.GeometryEvent:
		return a.onGeometry(ctx, e)
	case parser.OptConvergedEvent:
		return a.onOptConverged(ctx, e)
	case parser.OptNotConvergedEvent:
		return a.onOptNotConverged(ctx, e)
	case parser.NEBPhaseStartEvent:
		return a.onNEBPhaseStart(ctx, e)
	case parser.NEBConvergedEvent:
		return a.onNEBConverged(ctx, e)
	case parser.MECPPointEvent:
		return a.onMECPPoint(ctx, e)
	case parser.FrequenciesEvent:
		return a.onFrequencies(ctx, e)
	case parser.ExcitedStatesEvent:
		return a.onExcitedStates(ctx, e)
	case parser.NMRShieldsEvent:
		return a.onNMRShields(ctx, e)
	case parser.ThermoEvent:
		return a.onThermo(ctx, e)
	case parser.SpinContaminationEvent:
		return a.onSpinContamination(ctx, e)
	case parser.DiagnosticEvent:
		return a.onDiagnostic(ctx, e)
	case parser.RunStartEvent:
		return a.onRunStart(ctx, e)
	case parser.RunEndEvent:
		return a.onRunEnd(ctx, e)
	}
	return nil
}

// logEvent appends the raw event row for ev under the already-assigned
// sequence number.
func (a *eventAccumulator) logEvent(ctx context.Context, ev parser.Event, kind string, payload map[string]any) error {
	return a.tracker.AppendEvent(ctx, a.runID, tracker.Event{
		Seq: a.seq, TS: ev.When(), Kind: kind, Payload: payload,
	})
}

func (a *eventAccumulator) onScfIter(ctx context.Context, e parser.ScfIterEvent) error {
	logErr := a.logEvent(ctx, e, e.Kind(), map[string]any{
		"cycle": e.Cycle, "iter": e.Iter, "energy": e.Energy,
		"deltaE": e.DeltaE, "rmsdp": e.RMSDP, "maxdp": e.MaxDP, "timeS": e.TimeS,
	})
	cycle := e.Cycle
	iter := e.Iter
	metricErr := a.tracker.AppendMetric(ctx, a.runID, tracker.Metric{
		Key: "scf_iter_energy", TS: e.When(), Cycle: &cycle, Iter: &iter, Value: e.Energy,
	})
	return errors.Join(logErr, metricErr)
}

func (a *eventAccumulator) onScfConverged(ctx context.Context, e parser.ScfConvergedEvent) error {
	return a.logEvent(ctx, e, e.Kind(), map[string]any{"cycle": e.Cycle, "cycles": e.Cycles})
}

func (a *eventAccumulator) onTotalEnergy(ctx context.Context, e parser.TotalEnergyEvent) error {
	logErr := a.logEvent(ctx, e, e.Kind(), map[string]any{"cycle": e.Cycle, "total": e.Total})
	cycle := e.Cycle
	metricErr := a.tracker.AppendMetric(ctx, a.runID, tracker.Metric{
		Key: "total_energy", TS: e.When(), Cycle: &cycle, Value: e.Total,
	})
	return errors.Join(logErr, metricErr)
}

func (a *eventAccumulator) onFinalSP(ctx context.Context, e parser.FinalSPEvent) error {
	logErr := a.logEvent(ctx, e, e.Kind(), map[string]any{"cycle": e.Cycle, "energy": e.Energy})
	cycle := e.Cycle
	metricErr := a.tracker.AppendMetric(ctx, a.runID, tracker.Metric{
		Key: "final_sp", TS: e.When(), Cycle: &cycle, Value: e.Energy,
	})
	a.lastEnergy.Store(e.Energy)
	return errors.Join(logErr, metricErr)
}

func (a *eventAccumulator) onGeometry(ctx context.Context, e parser.GeometryEvent) error {
	geomErr := a.tracker.AppendGeometry(ctx, a.runID, e.Cycle, e.XYZ)
	logErr := a.logEvent(ctx, e, e.Kind(), map[string]any{"cycle": e.Cycle, "atoms": len(e.Atoms)})
	return errors.Join(geomErr, logErr)
}

func (a *eventAccumulator) onOptConverged(ctx context.Context, e parser.OptConvergedEvent) error {
	// In an NEB run, opt-converged banners before the band phase belong
	// to endpoint pre-optimizations — logged, but not run convergence.
	if !a.nebBand || a.nebStarted.Load() {
		a.optConverged.Store(true)
	}
	return a.logEvent(ctx, e, e.Kind(), map[string]any{})
}

func (a *eventAccumulator) onOptNotConverged(ctx context.Context, e parser.OptNotConvergedEvent) error {
	a.optMaxCycles.Store(true)
	return a.logEvent(ctx, e, e.Kind(), map[string]any{"reason": "max cycles reached"})
}

func (a *eventAccumulator) onNEBPhaseStart(ctx context.Context, e parser.NEBPhaseStartEvent) error {
	a.nebStarted.Store(true)
	return a.logEvent(ctx, e, e.Kind(), map[string]any{})
}

func (a *eventAccumulator) onNEBConverged(ctx context.Context, e parser.NEBConvergedEvent) error {
	a.nebConverged.Store(true)
	return a.logEvent(ctx, e, e.Kind(), map[string]any{})
}

func (a *eventAccumulator) onMECPPoint(ctx context.Context, e parser.MECPPointEvent) error {
	cycle := e.Cycle
	state1Err := a.tracker.AppendMetric(ctx, a.runID, tracker.Metric{
		Key: "mecp_state1_energy", TS: e.When(), Cycle: &cycle, Value: e.State1Energy,
	})
	state2Err := a.tracker.AppendMetric(ctx, a.runID, tracker.Metric{
		Key: "mecp_state2_energy", TS: e.When(), Cycle: &cycle, Value: e.State2Energy,
	})
	gapErr := a.tracker.AppendMetric(ctx, a.runID, tracker.Metric{
		Key: "mecp_gap", TS: e.When(), Cycle: &cycle, Value: e.Gap,
	})
	a.lastEnergy.Store((e.State1Energy + e.State2Energy) / 2)
	logErr := a.logEvent(ctx, e, e.Kind(), map[string]any{
		"cycle": e.Cycle, "state1Energy": e.State1Energy,
		"state2Energy": e.State2Energy, "gap": e.Gap,
	})
	return errors.Join(state1Err, state2Err, gapErr, logErr)
}

func (a *eventAccumulator) onFrequencies(ctx context.Context, e parser.FrequenciesEvent) error {
	items := make([]tracker.Frequency, len(e.Items))
	nImag := 0
	for i, f := range e.Items {
		items[i] = tracker.Frequency{Idx: f.Idx, Wavenumber: f.Wavenumber, Imaginary: f.Imaginary, IRIntensity: f.IRIntensity, HessIdx: e.HessIdx}
		if f.Imaginary {
			nImag++
		}
	}
	a.imaginaryModes.Store(int32(nImag))
	a.freqPostConv.Store(a.optConverged.Load())
	setErr := a.tracker.SetFrequencies(ctx, a.runID, items)
	logErr := a.logEvent(ctx, e, e.Kind(), map[string]any{"count": len(items)})
	return errors.Join(setErr, logErr)
}

func (a *eventAccumulator) onExcitedStates(ctx context.Context, e parser.ExcitedStatesEvent) error {
	items := make([]tracker.ExcitedState, len(e.Items))
	for i, s := range e.Items {
		transitions := make([]tracker.OrbitalTransition, len(s.Transitions))
		for j, t := range s.Transitions {
			transitions[j] = tracker.OrbitalTransition{From: t.From, To: t.To, Coeff: t.Coeff}
		}
		items[i] = tracker.ExcitedState{
			Idx: s.Index, EnergyEV: s.EnergyEV, WavelengthNM: s.WavelengthNM,
			OscStrength: s.OscStrength, Transitions: transitions,
		}
	}
	setErr := a.tracker.SetExcitedStates(ctx, a.runID, items)
	logErr := a.logEvent(ctx, e, e.Kind(), map[string]any{"count": len(items)})
	return errors.Join(setErr, logErr)
}

func (a *eventAccumulator) onNMRShields(ctx context.Context, e parser.NMRShieldsEvent) error {
	items := make([]tracker.NMRShield, len(e.Items))
	for i, s := range e.Items {
		items[i] = tracker.NMRShield{
			AtomIdx: s.AtomIdx, Element: s.Element,
			Isotropic: s.Isotropic, Anisotropy: s.Anisotropy,
		}
	}
	setErr := a.tracker.SetNMRShields(ctx, a.runID, items)
	logErr := a.logEvent(ctx, e, e.Kind(), map[string]any{"count": len(items)})
	return errors.Join(setErr, logErr)
}

func (a *eventAccumulator) onThermo(ctx context.Context, e parser.ThermoEvent) error {
	a.thermo.Store(e)
	a.thermoPostConv.Store(a.optConverged.Load())
	payload := map[string]any{}
	if e.ZPEEh != nil {
		payload["zpeEh"] = *e.ZPEEh
	}
	if e.EnthalpyEh != nil {
		payload["enthalpyEh"] = *e.EnthalpyEh
	}
	if e.EntropyCorrEh != nil {
		payload["entropyCorrEh"] = *e.EntropyCorrEh
	}
	if e.GibbsEh != nil {
		payload["gibbsEh"] = *e.GibbsEh
	}
	if e.GMinusEEh != nil {
		payload["gMinusEEh"] = *e.GMinusEEh
	}
	return a.logEvent(ctx, e, e.Kind(), payload)
}

func (a *eventAccumulator) onSpinContamination(ctx context.Context, e parser.SpinContaminationEvent) error {
	// Last block wins: for an Opt that is the final geometry's SCF, which
	// is the value chemists judge contamination by.
	a.spin.Store(e)
	return a.logEvent(ctx, e, e.Kind(), map[string]any{
		"s2": e.S2, "s2Ideal": e.S2Ideal,
	})
}

// onDiagnostic keeps the most severe diagnosis seen so far. The event is
// always logged — a failure the run recovered from (a reconverged
// wavefunction instability, say) is still worth showing on the timeline
// even though it never becomes the run's error class.
func (a *eventAccumulator) onDiagnostic(ctx context.Context, e parser.DiagnosticEvent) error {
	a.diagMu.Lock()
	switch {
	case e.Class == parser.ErrorClassOptMaxCycles:
		a.optCyclesExcerpt = e.Excerpt
	default:
		if e.Class.MoreSevereThan(a.diagClass) {
			a.diagClass, a.diagExcerpt = e.Class, e.Excerpt
		}
		if e.Class.IsHardFailure() && e.Class.MoreSevereThan(a.hardClass) {
			a.hardClass, a.hardExcerpt = e.Class, e.Excerpt
		}
	}
	a.diagMu.Unlock()
	return a.logEvent(ctx, e, e.Kind(), map[string]any{
		"class": e.Class.String(), "excerpt": e.Excerpt,
	})
}

func (a *eventAccumulator) onRunStart(ctx context.Context, e parser.RunStartEvent) error {
	payload := map[string]any{}
	status := tracker.StatusUpdate{}
	if e.OrcaVersion != "" {
		payload["orcaVersion"] = e.OrcaVersion
		status.OrcaVersion = &e.OrcaVersion
	}
	if e.NProcs > 0 {
		payload["nprocs"] = e.NProcs
		status.NProcs = &e.NProcs
	}
	if len(payload) == 0 {
		return nil
	}
	statusErr := a.tracker.UpdateRunStatus(ctx, a.runID, status)
	// Deliberately NOT e.Kind() ("run_start"): the stored event kind
	// has always been "stage_run_start" and the UI filters on it.
	logErr := a.logEvent(ctx, e, "stage_run_start", payload)
	return errors.Join(statusErr, logErr)
}

func (a *eventAccumulator) onRunEnd(ctx context.Context, e parser.RunEndEvent) error {
	secs := e.Wallclock.Seconds()
	logErr := a.logEvent(ctx, e, e.Kind(), map[string]any{
		"normal": e.Normal, "wallclockSec": secs,
	})
	if secs > 0 {
		a.wallclockSec.Store(secs)
	}
	if e.Normal {
		a.runEndNormal.Store(true)
	}
	return logErr
}

// finalStatusUpdate builds the run's terminal StatusUpdate from the
// accumulated aggregates. Convergence semantics:
//   - the optimizer reported convergence → converged (for NEB-TS this is
//     the final TS optimization; endpoint pre-opt banners are gated out)
//   - the input requested an optimization but it never converged and the
//     run still finished → explicitly NOT converged
//   - NEB runs without a TS phase (NEB, NEB-CI, ZOOM variants) → the
//     band's own convergence banner decides
//   - other non-opt runs (SP, IRC, SCAN, GOAT, MECP, …) that finished
//     with exit 0 count as converged — the SCF converged and the job
//     completed normally
func (a *eventAccumulator) finalStatusUpdate(status tracker.RunStatus, exitCode int, finished time.Time) tracker.StatusUpdate {
	summary := a.summary
	upd := tracker.StatusUpdate{
		Status:     status,
		ExitCode:   &exitCode,
		FinishedAt: &finished,
	}
	if le, ok := a.lastEnergy.Load().(float64); ok {
		upd.LastEnergy = &le
	}
	if ws, ok := a.wallclockSec.Load().(float64); ok {
		upd.WallclockSec = &ws
	}
	if c := a.optConverged.Load(); c {
		upd.Converged = &c
	} else if status == tracker.StatusFinished && summary.RequestsOptimization() {
		f := false
		upd.Converged = &f
	} else if status == tracker.StatusFinished && summary.RequestsNEBBand() {
		c := a.nebConverged.Load()
		upd.Converged = &c
	} else if status == tracker.StatusFinished {
		t := true
		upd.Converged = &t
	}
	if a.optMaxCycles.Load() && !a.optConverged.Load() {
		t := true
		upd.OptMaxCycles = &t
	}
	// For optimization runs, only a section printed AFTER convergence
	// describes the final geometry: calc_hess prints frequencies +
	// thermochemistry for the starting structure, and counting those
	// would flag a clean Opt as "has imaginary modes" with the wrong
	// thermochemistry attached.
	requestsOpt := summary.RequestsOptimization()
	if im := a.imaginaryModes.Load(); im >= 0 && (!requestsOpt || a.freqPostConv.Load()) {
		n := int(im)
		upd.ImaginaryModes = &n
	}
	if th, ok := a.thermo.Load().(parser.ThermoEvent); ok && (!requestsOpt || a.thermoPostConv.Load()) {
		upd.ZPEEh = th.ZPEEh
		upd.EnthalpyEh = th.EnthalpyEh
		upd.EntropyCorrEh = th.EntropyCorrEh
		upd.GibbsEh = th.GibbsEh
		upd.GMinusEEh = th.GMinusEEh
	}
	if sp, ok := a.spin.Load().(parser.SpinContaminationEvent); ok {
		upd.S2 = &sp.S2
		upd.S2Ideal = &sp.S2Ideal
	}
	if class, excerpt := a.diagnose(status, exitCode, upd.OptMaxCycles != nil); class != "" {
		s := class.String()
		upd.ErrorClass = &s
		if excerpt != "" {
			upd.ErrorExcerpt = &excerpt
		}
	}
	return upd
}

// diagnose is the run's single failure verdict: the class and excerpt to
// store, or ("", "") for a clean run.
//
// A run counts as clean when it finished with exit 0 AND printed ORCA's
// own "TERMINATED NORMALLY" line — the live path and the offline import
// path derive both the same way, so identical output yields an identical
// verdict. On a clean run only a self-standing failure is reported
// (ErrorClass.IsHardFailure); context-dependent diagnoses are dropped,
// because a run that recovered from them did not fail.
//
// optStalled is the caller's already-computed OptMaxCycles verdict rather
// than a second reading of the flag, so the errorClass and optMaxCycles
// columns cannot disagree. A stalled optimizer is a failure verdict even
// when ORCA terminated normally: the run reached its cycle limit and its
// geometry is not a stationary point.
func (a *eventAccumulator) diagnose(status tracker.RunStatus, exitCode int, optStalled bool) (parser.ErrorClass, string) {
	a.diagMu.Lock()
	class, excerpt := a.diagClass, a.diagExcerpt
	hardClass, hardExcerpt := a.hardClass, a.hardExcerpt
	optExcerpt := a.optCyclesExcerpt
	a.diagMu.Unlock()

	clean := status == tracker.StatusFinished && exitCode == 0 && a.runEndNormal.Load()
	if clean {
		class, excerpt = hardClass, hardExcerpt
	}
	if optStalled && parser.ErrorClassOptMaxCycles.MoreSevereThan(class) {
		class, excerpt = parser.ErrorClassOptMaxCycles, optExcerpt
	}
	if class != "" {
		return class, excerpt
	}
	if clean {
		return "", ""
	}
	// The run failed and nothing in the output says why — killed by the
	// scheduler, out of walltime, segfaulted mid-write.
	return parser.ErrorClassUnknown, ""
}
