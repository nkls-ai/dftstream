package restart

import (
	"context"
	"strings"

	"github.com/nkls-ai/dftstream/internal/parser"
)

// OutputDiagnosis is the run-level failure verdict for one .out, plus the
// raw data the fix builders read (the failing SCF's energy trace).
type OutputDiagnosis struct {
	// Class is the run-level parser.ErrorClass ("" for a clean run).
	Class parser.ErrorClass
	// Excerpt quotes the lines around the diagnosis, when one exists.
	Excerpt string
	// LastSCFEnergies are the iteration energies of the LAST SCF table in
	// the output — for a run that died in the SCF, the failing one.
	LastSCFEnergies []float64
}

// DiagnoseOutput classifies a finished .out with the SAME landmark rules
// the live runner uses: it streams the text through the parser and folds
// the DiagnosticEvents with parser.RunVerdict. restart has no failure
// classifier of its own — the geometric OK/IMAG/FREQ_BROKE/OPT_BROKE
// triage (Classify) only decides HOW to restart once the verdict says
// nothing more specific.
//
// nebBand marks runs whose input drives the NEB band optimizer: their
// endpoint pre-optimizations print the plain opt-converged banner, which
// must not count as run convergence (mirrors the runner's gate).
func DiagnoseOutput(text string, nebBand bool) (OutputDiagnosis, error) {
	ch := make(chan parser.Event, 256)
	done := make(chan error, 1)
	go func() {
		done <- parser.New(nil).Parse(context.Background(), strings.NewReader(text), ch)
		close(ch)
	}()

	var (
		diags        []parser.DiagnosticEvent
		optConverged bool
		optMaxCycles bool
		nebStarted   bool
		terminated   bool

		scf      []float64
		lastIter = -1
	)
	for e := range ch {
		switch ev := e.(type) {
		case parser.DiagnosticEvent:
			diags = append(diags, ev)
		case parser.OptConvergedEvent:
			if !nebBand || nebStarted {
				optConverged = true
			}
		case parser.NEBPhaseStartEvent:
			nebStarted = true
		case parser.OptNotConvergedEvent:
			optMaxCycles = true
		case parser.RunEndEvent:
			if ev.Normal {
				terminated = true
			}
		case parser.ScfIterEvent:
			// A non-increasing iteration index starts a new SCF table;
			// only the last table (the failing one, for an SCF death) is
			// kept.
			if ev.Iter <= lastIter {
				scf = scf[:0]
			}
			scf = append(scf, ev.Energy)
			lastIter = ev.Iter
		}
	}
	if err := <-done; err != nil {
		return OutputDiagnosis{}, err
	}

	class, excerpt := parser.RunVerdict(diags, parser.VerdictInput{
		TerminatedNormally: terminated,
		OptStalled:         optMaxCycles && !optConverged,
	})
	return OutputDiagnosis{Class: class, Excerpt: excerpt, LastSCFEnergies: scf}, nil
}

// SCFTrend is the shape of a failing SCF's energy trace, which decides
// the stage-2 convergence fix: an oscillating energy means the occupation
// is flipping between near-degenerate solutions (level shift), a steady
// descent means convergence is real but slow (damping + more iterations).
type SCFTrend int

const (
	// TrendUnknown: not enough iterations to call it.
	TrendUnknown SCFTrend = iota
	// TrendDescending: the energy creeps downward — convergence is real,
	// it just ran out of iterations.
	TrendDescending
	// TrendOscillating: the energy repeatedly rises — the occupation is
	// flipping between near-degenerate solutions.
	TrendOscillating
)

func (t SCFTrend) String() string {
	switch t {
	case TrendDescending:
		return "descending"
	case TrendOscillating:
		return "oscillating"
	default:
		return "unknown"
	}
}

// scfTrendWindow bounds the trend analysis to the tail of the trace: the
// first iterations of any SCF jump around while DIIS builds its subspace,
// and only the late behavior says why convergence failed.
const (
	scfTrendWindow    = 16
	scfTrendMinDeltas = 5
	// scfRiseThresholdEh separates a genuine energy rise from float noise
	// on a converging trace (well below chemical accuracy).
	scfRiseThresholdEh = 1e-9
)

// AnalyzeSCFTrend classifies the tail of an SCF energy trace. At least
// scfTrendMinDeltas steps are required; oscillation is called when 30% or
// more of the steps in the window raised the energy.
func AnalyzeSCFTrend(energies []float64) SCFTrend {
	if len(energies) < scfTrendMinDeltas+1 {
		return TrendUnknown
	}
	tail := energies
	if len(tail) > scfTrendWindow+1 {
		tail = tail[len(tail)-scfTrendWindow-1:]
	}
	rises, steps := 0, 0
	for i := 1; i < len(tail); i++ {
		steps++
		if tail[i]-tail[i-1] > scfRiseThresholdEh {
			rises++
		}
	}
	if rises*10 >= steps*3 {
		return TrendOscillating
	}
	return TrendDescending
}
