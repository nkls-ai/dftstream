// Package parser turns an ORCA stdout stream into typed events.
package parser

import "time"

type Atom struct {
	Symbol  string
	X, Y, Z float64
}

type Frequency struct {
	Idx         int
	Wavenumber  float64
	Imaginary   bool
	IRIntensity float64 // km/mol, 0 if unavailable
}

// Event is the union of all parser outputs. Consumers type-switch.
type Event interface {
	When() time.Time
	Kind() string
}

type base struct {
	TS time.Time
}

func (b base) When() time.Time { return b.TS }

type RunStartEvent struct {
	base
	OrcaVersion string
	NProcs      int
	MaxCoreMB   int
}

func (RunStartEvent) Kind() string { return "run_start" }

type GeometryEvent struct {
	base
	Cycle int
	Atoms []Atom
	XYZ   string
}

func (GeometryEvent) Kind() string { return "geometry" }

type ScfIterEvent struct {
	base
	Cycle  int
	Iter   int
	Energy float64
	DeltaE float64
	RMSDP  float64
	MaxDP  float64
	TimeS  float64
}

func (ScfIterEvent) Kind() string { return "scf_iter" }

type ScfConvergedEvent struct {
	base
	Cycle  int
	Cycles int
}

func (ScfConvergedEvent) Kind() string { return "scf_converged" }

type TotalEnergyEvent struct {
	base
	Cycle      int
	Total      float64
	Nuclear    float64
	Electronic float64
	OneEl      float64
	TwoEl      float64
}

func (TotalEnergyEvent) Kind() string { return "total_energy" }

type FinalSPEvent struct {
	base
	Cycle  int
	Energy float64
}

func (FinalSPEvent) Kind() string { return "final_sp" }

type FrequenciesEvent struct {
	base
	Items []Frequency
	// HessIdx is the 1-based ordinal of the VIBRATIONAL FREQUENCIES block
	// this event came from — runs with Calc_Hess/Recalc_Hess print several.
	HessIdx int
}

func (FrequenciesEvent) Kind() string { return "frequencies" }

// ThermoEvent carries one parsed THERMOCHEMISTRY section. All values are
// in Hartree (Eh); nil means the line was absent from the section. A run
// with several frequency calculations (e.g. OptFreq restarts) emits one
// event per section — consumers keep the last.
type ThermoEvent struct {
	base
	ZPEEh         *float64
	EnthalpyEh    *float64
	EntropyCorrEh *float64
	GibbsEh       *float64
	GMinusEEh     *float64
}

func (ThermoEvent) Kind() string { return "thermo" }

// SpinContaminationEvent carries one parsed <S**2> block (UHF/UKS only).
// ORCA prints one per SCF; consumers keep the last (final geometry).
type SpinContaminationEvent struct {
	base
	S2      float64 // Expectation value of <S**2>
	S2Ideal float64 // Ideal value S*(S+1)
}

func (SpinContaminationEvent) Kind() string { return "spin_contamination" }

type OptConvergedEvent struct {
	base
}

func (OptConvergedEvent) Kind() string { return "opt_converged" }

// OptNotConvergedEvent fires on ORCA's explicit "The optimization did not
// converge" message (max cycles reached with normal termination) — it
// distinguishes a max-cycles stop from a crash in the run's event log.
type OptNotConvergedEvent struct {
	base
}

func (OptNotConvergedEvent) Kind() string { return "opt_not_converged" }

// NEBPhaseStartEvent fires on the "NEB OPTIMIZATION" section header:
// the band optimization begins here, so any earlier opt-converged
// banners belong to endpoint pre-optimizations, not the run itself.
type NEBPhaseStartEvent struct {
	base
}

func (NEBPhaseStartEvent) Kind() string { return "neb_phase_start" }

// NEBConvergedEvent fires on "THE NEB OPTIMIZATION HAS CONVERGED" —
// the band (and climbing image, when requested) reached a MEP. For
// NEB-TS runs the final TS optimization starts after this point.
type NEBConvergedEvent struct {
	base
}

func (NEBConvergedEvent) Kind() string { return "neb_converged" }

type MECPPointEvent struct {
	base
	Cycle        int
	State1Energy float64
	State2Energy float64
	Gap          float64
}

func (MECPPointEvent) Kind() string { return "mecp_point" }

type OrbitalTransition struct {
	From  string  // e.g. "137a" (HOMO)
	To    string  // e.g. "138a" (LUMO)
	Coeff float64 // contribution coefficient
}

type ExcitedState struct {
	Index        int
	EnergyCM     float64 // cm⁻¹
	EnergyEV     float64
	WavelengthNM float64
	OscStrength  float64
	Transitions  []OrbitalTransition
}

type ExcitedStatesEvent struct {
	base
	Items []ExcitedState
}

func (ExcitedStatesEvent) Kind() string { return "excited_states" }

type NMRShield struct {
	AtomIdx    int
	Element    string
	Isotropic  float64
	Anisotropy float64
}

type NMRShieldsEvent struct {
	base
	Items []NMRShield
}

func (NMRShieldsEvent) Kind() string { return "nmr_shields" }

// DiagnosticEvent carries one classified failure landmark plus a short
// excerpt of the output around it. The parser emits at most one event per
// ErrorClass per run; consumers keep the most severe one (see
// ErrorClass.MoreSevereThan). Its presence does NOT mean the run failed —
// a wavefunction instability that ORCA reconverged, for instance, still
// ends in a clean run — so the verdict is the consumer's to make.
type DiagnosticEvent struct {
	base
	Class   ErrorClass
	Excerpt string
}

func (DiagnosticEvent) Kind() string { return "diagnostic" }

type RunEndEvent struct {
	base
	Wallclock time.Duration
	Normal    bool
}

func (RunEndEvent) Kind() string { return "run_end" }
