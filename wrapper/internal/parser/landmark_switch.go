package parser

import (
	"regexp"
	"strings"
	"time"
)

// handleLandmark is the global landmark dispatch that recognises section
// headers and one-line facts on any non-consumed line. Returns false
// when an emit blocked on a canceled context.
func (r *parseRun) handleLandmark(line, upperLine string) bool {
	switch {
	// The input echo is quoted user text: a comment or a filename in it
	// must never be read as an ORCA failure banner. The header is a
	// centered banner line of its own, so match it exactly rather than by
	// Contains — "Error opening pNMR input file" contains it too.
	case strings.TrimSpace(upperLine) == lmInputFileHeader:
		r.inInputEcho = true

	case strings.Contains(upperLine, lmInputFileEnd):
		r.inInputEcho = false

	// Failure banners come first: they are disjoint from the data
	// landmarks below (opt-max-cycles, the one overlap, is raised from its
	// own case) and a diagnosis must never be shadowed by a section
	// header that happens to appear on the same line.
	case !r.inInputEcho && r.classifyDiagnostic(upperLine, line):
		// classifyDiagnostic opened the excerpt capture for this line.

	case strings.Contains(line, lmGeomOptCycle):
		if !r.flushMECP() {
			return false
		}
		r.resetMECPPoint()
		if m := reCycle.FindStringSubmatch(line); m != nil {
			if n, ok := parseInt(m[1]); ok {
				r.currentCycle = n
			}
		}

	case strings.Contains(upperLine, lmMECPConverged):
		if !r.flushMECP() {
			return false
		}
		if !r.emit(OptConvergedEvent{base: base{TS: r.p.now()}}) {
			return false
		}

	case strings.Contains(upperLine, lmMECPHeader) || strings.Contains(upperLine, lmMECPOptimization):
		r.mecpActive = true

	case strings.Contains(line, lmCoordsAngstrom):
		r.enterSection(stGeometry)
		r.atoms = r.atoms[:0]

	case strings.Contains(line, lmScfTableHeader):
		// The header is a separator line like "----D-I-I-S----". The
		// next blank line will end the table; rows come in between.
		r.enterSection(stScfTable)

	case strings.Contains(line, lmScfConverged):
		if m := reScfConverged.FindStringSubmatch(line); m != nil {
			n, ok := parseInt(m[1])
			if !ok {
				break
			}
			if !r.emit(ScfConvergedEvent{
				base: base{TS: r.p.now()}, Cycle: r.currentCycle, Cycles: n,
			}) {
				return false
			}
		}

	case strings.Contains(line, lmTotalEnergy):
		if m := reTotalEnergy.FindStringSubmatch(line); m != nil {
			v, ok := parseFloat(m[1])
			if !ok {
				break
			}
			if !r.emit(TotalEnergyEvent{
				base: base{TS: r.p.now()}, Cycle: r.currentCycle, Total: v,
			}) {
				return false
			}
		}

	case strings.Contains(line, lmFinalSP):
		if m := reFinalSP.FindStringSubmatch(line); m != nil {
			v, ok := parseFloat(m[1])
			if !ok {
				break
			}
			if !r.emit(FinalSPEvent{
				base: base{TS: r.p.now()}, Cycle: r.currentCycle, Energy: v,
			}) {
				return false
			}
		}

	// The banner is a line of its own ("VIBRATIONAL FREQUENCIES", or
	// "VIBRATIONAL FREQUENCIES PES2" on the second surface of an MECP
	// run), so anchor on the start of the trimmed line rather than
	// Contains. An MECP run also prints the sentence "The VIBRATIONAL
	// FREQUENCIES include only those modes parallel to the crossing
	// hyperline", which Contains treated as a third Hessian: hessCount
	// ran one ahead and every block's HessIdx — what the UI's Hessian
	// history selects on — pointed at the wrong one.
	case strings.HasPrefix(strings.TrimSpace(line), lmVibFreqs):
		// Flush any pending freqs from a previous block (e.g. if IR section was skipped)
		if !r.flushFreqs() {
			return false
		}
		r.hessCount++
		r.enterSection(stFrequencies)
		r.freqs = r.freqs[:0]

	case strings.Contains(line, lmIRSpectrum):
		r.enterSection(stIRSpectrum)

	case strings.Contains(line, lmNEBConverged):
		if !r.emit(NEBConvergedEvent{base: base{TS: r.p.now()}}) {
			return false
		}

	case strings.TrimSpace(line) == lmNEBHeader:
		if !r.emit(NEBPhaseStartEvent{base: base{TS: r.p.now()}}) {
			return false
		}

	case strings.Contains(line, lmOptConverged):
		if !r.emit(OptConvergedEvent{base: base{TS: r.p.now()}}) {
			return false
		}

	case strings.Contains(line, lmOptNotConverged):
		// One landmark, two signals: the event drives the accumulator's
		// optMaxCycles flag and the capture supplies the excerpt for the
		// opt_max_cycles error class, so the two can never disagree.
		if !r.startDiagnostic(ErrorClassOptMaxCycles, line) {
			return false
		}
		if !r.emit(OptNotConvergedEvent{base: base{TS: r.p.now()}}) {
			return false
		}

	case strings.Contains(line, lmS2Expectation):
		if m := reS2Expectation.FindStringSubmatch(line); m != nil {
			if v, ok := parseFloat(m[1]); ok {
				r.s2Pending = v
				r.s2PendingSeen = true
			}
		}

	case strings.Contains(line, lmS2Ideal):
		if m := reS2Ideal.FindStringSubmatch(line); m != nil {
			if v, ok := parseFloat(m[1]); ok && r.s2PendingSeen {
				r.s2PendingSeen = false
				if !r.emit(SpinContaminationEvent{
					base: base{TS: r.p.now()}, S2: r.s2Pending, S2Ideal: v,
				}) {
					return false
				}
			}
		}

	case r.captureThermo(line):
		// captureThermo stored the value (and flushed the section on its
		// last row).

	case strings.Contains(line, lmNMRShielding):
		r.enterSection(stNMRShielding)
		r.nmrShields = r.nmrShields[:0]

	case strings.Contains(line, lmAbsSpectrum):
		r.enterSection(stAbsSpectrum)
		r.absSpectrumRows = r.absSpectrumRows[:0]

	case strings.Contains(line, lmTDDFTStates) || strings.Contains(line, lmCISStates):
		r.enterSection(stTDDFTStates)
		r.excitedStates = r.excitedStates[:0]
		r.currentTDState = nil

	case strings.Contains(line, lmOrcaTerminatedOk):
		r.runEndNormal = true

	case strings.Contains(line, lmTotalRunTime):
		if m := reRunTime.FindStringSubmatch(line); m != nil {
			days, ok1 := parseInt(m[1])
			hours, ok2 := parseInt(m[2])
			minutes, ok3 := parseInt(m[3])
			secs, ok4 := parseInt(m[4])
			msec, ok5 := parseInt(m[5])
			if !ok1 || !ok2 || !ok3 || !ok4 || !ok5 {
				break
			}
			d := time.Duration(days)*24*time.Hour +
				time.Duration(hours)*time.Hour +
				time.Duration(minutes)*time.Minute +
				time.Duration(secs)*time.Second +
				time.Duration(msec)*time.Millisecond
			r.runEndWallclock = d
		}

	case strings.Contains(line, lmProgramVersion):
		if m := reOrcaVersion.FindStringSubmatch(line); m != nil {
			if !r.emit(RunStartEvent{
				base: base{TS: r.p.now()}, OrcaVersion: m[1],
			}) {
				return false
			}
		}

	case strings.Contains(line, lmParallelMPIProc):
		if m := reMPIProcs.FindStringSubmatch(line); m != nil {
			n, ok := parseInt(m[1])
			if !ok {
				break
			}
			if !r.emit(RunStartEvent{
				base: base{TS: r.p.now()}, NProcs: n,
			}) {
				return false
			}
		}
	}
	return !r.landmarkAborted
}

// flushThermo emits the accumulated thermochemistry section, normally
// once its final row (G-E(el)) is seen, plus at EOF for partial
// sections from truncated/killed runs.
func (r *parseRun) flushThermo() bool {
	if !r.thermoSeen {
		return true
	}
	ev := r.thermo
	ev.base = base{TS: r.p.now()}
	r.thermo = ThermoEvent{}
	r.thermoSeen = false
	return r.emit(ev)
}

// thermoRow is one value row of ORCA's THERMOCHEMISTRY section.
type thermoRow struct {
	landmark string
	re       *regexp.Regexp
	field    func(*ThermoEvent) **float64
	// last marks G-E(el), the section's final row: seeing it emits the
	// whole section.
	last bool
}

// thermoRows are matched in order; the landmarks are disjoint.
var thermoRows = []thermoRow{
	{lmZeroPointEnergy, reZeroPointEnergy, func(t *ThermoEvent) **float64 { return &t.ZPEEh }, false},
	{lmTotalEnthalpy, reTotalEnthalpy, func(t *ThermoEvent) **float64 { return &t.EnthalpyEh }, false},
	{lmEntropyCorrection, reEntropyCorrection, func(t *ThermoEvent) **float64 { return &t.EntropyCorrEh }, false},
	{lmFinalGibbs, reFinalGibbs, func(t *ThermoEvent) **float64 { return &t.GibbsEh }, false},
	{lmGMinusE, reGMinusE, func(t *ThermoEvent) **float64 { return &t.GMinusEEh }, true},
}

// captureThermo reports whether line is a thermochemistry row and, if so,
// records its value. A row whose number does not match its pattern is
// still consumed (as the separate switch cases did), and an unparsable
// number is skipped rather than stored as zero. Used as a boolean case in
// the landmark switch, so a section flush that blocks on a canceled context
// is recorded in landmarkAborted rather than returned.
func (r *parseRun) captureThermo(line string) bool {
	for _, row := range thermoRows {
		if !strings.Contains(line, row.landmark) {
			continue
		}
		m := row.re.FindStringSubmatch(line)
		if m == nil {
			return true
		}
		if v, ok := parseFloat(m[1]); ok {
			*row.field(&r.thermo) = &v
			r.thermoSeen = true
		}
		if row.last && !r.flushThermo() {
			r.landmarkAborted = true
		}
		return true
	}
	return false
}
