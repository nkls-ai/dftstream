package inputparse

import "strings"

// RunType is one normalized run-type keyword from an ORCA '!' line
// (always upper-case, e.g. RunTypeOpt). It is the single home for
// job-classification predicates so the semantics cannot drift between
// call sites.
type RunType string

const (
	RunTypeSP         RunType = "SP"
	RunTypeEnergy     RunType = "ENERGY"
	RunTypeEngrad     RunType = "ENGRAD"
	RunTypeOpt        RunType = "OPT"
	RunTypeOptTS      RunType = "OPTTS"
	RunTypeCOpt       RunType = "COPT"
	RunTypeGoat       RunType = "GOAT"
	RunTypeMECP       RunType = "MECP"
	RunTypeFreq       RunType = "FREQ"
	RunTypeNumFreq    RunType = "NUMFREQ"
	RunTypeAnFreq     RunType = "ANFREQ"
	RunTypeNEB        RunType = "NEB"
	RunTypeNEBCI      RunType = "NEB-CI"
	RunTypeNEBTS      RunType = "NEB-TS"
	RunTypeZoomNEB    RunType = "ZOOM-NEB"
	RunTypeZoomNEBCI  RunType = "ZOOM-NEB-CI"
	RunTypeZoomNEBTS  RunType = "ZOOM-NEB-TS"
	RunTypeNEBIDPP    RunType = "NEB-IDPP"
	RunTypeIRC        RunType = "IRC"
	RunTypeScan       RunType = "SCAN"
	RunTypeScanTS     RunType = "SCANTS"
	RunTypeMD         RunType = "MD"
	RunTypeProperties RunType = "PROPERTIES"
	RunTypeProp       RunType = "PROP"
	RunTypeTDDFT      RunType = "TDDFT"
	RunTypeTDA        RunType = "TDA"
	RunTypeCIS        RunType = "CIS"
	RunTypeESD        RunType = "ESD"
	RunTypeNMR        RunType = "NMR"
	RunTypeEPRNMR     RunType = "EPRNMR"
)

func (t RunType) String() string { return string(t) }

// IsOptimization reports whether this run type ends in a geometry
// optimization whose convergence decides run success. Plain OPT/OPTTS/
// COPT run it directly; NEB-TS variants finish with an OptTS phase that
// prints the same "THE OPTIMIZATION HAS CONVERGED" criterion. Still
// narrower than DrivesGeometry: GOAT/NEB-CI/IRC/SCAN/... move geometry
// too but have no such single criterion.
func (t RunType) IsOptimization() bool {
	switch t {
	case RunTypeOpt, RunTypeOptTS, RunTypeCOpt, RunTypeNEBTS, RunTypeZoomNEBTS:
		return true
	}
	return false
}

// IsTransitionStateSearch reports whether the run targets a saddle
// point, where exactly one imaginary mode is the success condition:
// OptTS directly, and the NEB-TS variants via their final OptTS phase.
// SCANTS is deliberately excluded until the parser can attribute the
// scan→TS handoff (every relaxed-scan point prints the opt-converged
// banner, which would corrupt the convergence gates).
func (t RunType) IsTransitionStateSearch() bool {
	switch t {
	case RunTypeOptTS, RunTypeNEBTS, RunTypeZoomNEBTS:
		return true
	}
	return false
}

// IsNEBBand reports whether the run type runs the NEB band optimizer
// (the phase that ends in "THE NEB OPTIMIZATION HAS CONVERGED").
// NEB-IDPP only interpolates an initial path and never enters that
// phase, so it is excluded.
func (t RunType) IsNEBBand() bool {
	switch t {
	case RunTypeNEB, RunTypeNEBCI, RunTypeNEBTS,
		RunTypeZoomNEB, RunTypeZoomNEBCI, RunTypeZoomNEBTS:
		return true
	}
	return false
}

// IsFreq reports a frequency calculation (analytic or numerical).
func (t RunType) IsFreq() bool {
	return t == RunTypeFreq || t == RunTypeNumFreq || t == RunTypeAnFreq
}

// DrivesGeometry reports whether the run type drives its own geometry
// loop, so an opt-tier keyword (TightOpt, ...) merely tunes convergence
// criteria instead of requesting an extra OPT.
func (t RunType) DrivesGeometry() bool {
	switch t {
	case RunTypeOpt, RunTypeOptTS, RunTypeCOpt, RunTypeGoat, RunTypeMECP,
		RunTypeNEB, RunTypeNEBCI, RunTypeNEBTS,
		RunTypeZoomNEB, RunTypeZoomNEBCI, RunTypeZoomNEBTS, RunTypeNEBIDPP,
		RunTypeIRC, RunTypeScan, RunTypeScanTS, RunTypeMD:
		return true
	}
	return false
}

// JobType is the short combined label derived from RunTypes (e.g.
// "OPT_FREQ") used to tag runs in the tracker.
type JobType string

const (
	JobTypeOpt       JobType = "OPT"
	JobTypeOptFreq   JobType = "OPT_FREQ"
	JobTypeOptTS     JobType = "OPTTS"
	JobTypeOptTSFreq JobType = "OPTTS_FREQ"
	JobTypeFreq      JobType = "FREQ"
)

func (j JobType) String() string { return string(j) }

// IsGeometryOpt reports whether the job is a plain geometry optimization
// with one FINAL SINGLE POINT per optimization cycle (so e.g. per-cycle
// .gbw snapshots make sense). COPT never appears here: deriveJobType
// folds it into JobTypeOpt/JobTypeOptFreq. GOAT/SCAN/NEB/MD/IRC print
// FINAL SINGLE POINT ENERGY many times per "cycle" and are excluded.
func (j JobType) IsGeometryOpt() bool {
	switch j {
	case JobTypeOpt, JobTypeOptFreq, JobTypeOptTS, JobTypeOptTSFreq:
		return true
	}
	return false
}

// RequestsOptimization reports whether the input asks for a geometry
// optimization whose convergence gates run success (see
// RunType.IsOptimization).
func (s Summary) RequestsOptimization() bool {
	for _, t := range s.RunTypes {
		if t.IsOptimization() {
			return true
		}
	}
	return false
}

// RequestsTransitionState reports whether the input asks for a
// transition-state (saddle point) optimization.
func (s Summary) RequestsTransitionState() bool {
	for _, t := range s.RunTypes {
		if t.IsTransitionStateSearch() {
			return true
		}
	}
	return false
}

// RequestsNEBBand reports whether the input runs the NEB band optimizer
// (see RunType.IsNEBBand). Endpoint pre-optimizations inside such runs
// print the plain opt-converged banner and must not count as run
// convergence.
func (s Summary) RequestsNEBBand() bool {
	for _, t := range s.RunTypes {
		if t.IsNEBBand() {
			return true
		}
	}
	return false
}

// IsOptKeyword reports whether a raw '!' token requests a geometry
// optimization: an opt run type or an opt tier, which implies Opt in
// ORCA even without an explicit `Opt` keyword.
func IsOptKeyword(tok string) bool {
	up := strings.ToUpper(tok)
	if optTierSet[up] {
		return true
	}
	return RunType(up).IsOptimization()
}

// IsFreqKeyword reports whether a raw '!' token requests a frequency
// calculation.
func IsFreqKeyword(tok string) bool {
	return RunType(strings.ToUpper(tok)).IsFreq()
}

// IsNEBKeyword reports whether a raw '!' token requests any NEB driver
// (band variants, their convergence-preset aliases, or the IDPP
// interpolation) — the tokens that require a %neb block to make sense.
func IsNEBKeyword(tok string) bool {
	rt, ok := normalizeRunType(strings.ToUpper(tok))
	return ok && (rt.IsNEBBand() || rt == RunTypeNEBIDPP)
}
