package parser

import (
	"fmt"
	"strconv"
	"strings"
)

// emitPendingGeometry emits the accumulated geometry block, if any.
func (r *parseRun) emitPendingGeometry() bool {
	if len(r.atoms) == 0 {
		return true
	}
	return r.emit(GeometryEvent{
		base:  base{TS: r.p.now()},
		Cycle: r.currentCycle,
		Atoms: append([]Atom(nil), r.atoms...),
		XYZ:   buildXYZ(r.atoms, r.currentCycle),
	})
}

func (r *parseRun) handleGeometryLine(line string) lineOutcome {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		// End of geometry block.
		if !r.emitPendingGeometry() {
			return lineAborted
		}
		r.atoms = r.atoms[:0]
		r.resetIdle()
		return lineConsumed
	}
	if strings.HasPrefix(trimmed, "-") {
		// Separator dash lines occur inside the header — skip.
		return lineConsumed
	}
	if m := reAtom.FindStringSubmatch(line); m != nil {
		x, xOk := parseFloat(m[2])
		y, yOk := parseFloat(m[3])
		z, zOk := parseFloat(m[4])
		if !xOk || !yOk || !zOk {
			return lineConsumed
		}
		r.atoms = append(r.atoms, Atom{Symbol: m[1], X: x, Y: y, Z: z})
		return lineConsumed
	}
	// Unrecognised line inside a geometry block — end the block and let
	// the global handlers see this line.
	if !r.emitPendingGeometry() {
		return lineAborted
	}
	r.atoms = r.atoms[:0]
	r.resetIdle()
	return lineFallthrough
}

func (r *parseRun) handleScfTableLine(line string) lineOutcome {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" || strings.Contains(trimmed, "SUCCESS") {
		r.resetIdle()
		return lineConsumed
	}
	// The SCF failure banner closes the table exactly like the SUCCESS
	// one. Without this the table would keep swallowing lines (its
	// fallback consumes anything unrecognised) and the "SCF NOT CONVERGED
	// AFTER n CYCLES" line inside the banner would never reach the
	// landmark dispatch that diagnoses it.
	if strings.Contains(trimmed, "ERROR") {
		r.resetIdle()
		return lineFallthrough
	}
	if isScfTablePreamble(trimmed) {
		return lineConsumed
	}
	if m := reScfIter.FindStringSubmatch(line); m != nil {
		iter, ok1 := parseInt(m[1])
		energy, ok2 := parseFloat(m[2])
		timeS, ok6 := parseFloat(m[6])
		// iter, energy and the trailing time are the mandatory groups in
		// reScfIter; only drop the row if one of those fails to parse.
		if !ok1 || !ok2 || !ok6 {
			return lineConsumed
		}
		// Delta-E/RMSDP/MaxDP are OPTIONAL columns in reScfIter — an
		// absent column yields an empty submatch, so parseFloat returns
		// !ok. Treat that as zero rather than discarding the whole
		// iteration (which would punch holes in the convergence plot).
		delta, _ := parseFloat(m[3]) //nolint:errcheck — optional column, empty = 0
		rmsdp, _ := parseFloat(m[4]) //nolint:errcheck — optional column, empty = 0
		maxdp, _ := parseFloat(m[5]) //nolint:errcheck — optional column, empty = 0
		if !r.emit(ScfIterEvent{
			base:   base{TS: r.p.now()},
			Cycle:  r.currentCycle,
			Iter:   iter,
			Energy: energy,
			DeltaE: delta,
			RMSDP:  rmsdp,
			MaxDP:  maxdp,
			TimeS:  timeS,
		}) {
			return lineAborted
		}
		return lineConsumed
	}
	// Some SCF rows print without the trailing time column (final
	// converged row). Try a looser parse: iter + energy.
	fields := strings.Fields(line)
	if len(fields) >= 2 {
		if iter, err := strconv.Atoi(fields[0]); err == nil {
			if energy, err := strconv.ParseFloat(fields[1], 64); err == nil {
				if !r.emit(ScfIterEvent{
					base:   base{TS: r.p.now()},
					Cycle:  r.currentCycle,
					Iter:   iter,
					Energy: energy,
				}) {
					return lineAborted
				}
				return lineConsumed
			}
		}
	}
	// ORCA can interleave warnings and mode-switch messages in SCF tables.
	// Stay in the table until an explicit blank/success terminator.
	return lineConsumed
}

func (r *parseRun) handleFrequenciesLine(line string) lineOutcome {
	if m := reFreqRow.FindStringSubmatch(line); m != nil {
		idx, idxOk := parseInt(m[1])
		wn, wnOk := parseFloat(m[2])
		if !idxOk || !wnOk {
			return lineConsumed
		}
		imag := strings.Contains(m[3], "imaginary")
		r.freqs = append(r.freqs, Frequency{Idx: idx, Wavenumber: wn, Imaginary: imag})
		return lineConsumed
	}
	trimmed := strings.TrimSpace(line)
	// Tolerate decorative lines (separators, "Scaling factor..." preamble)
	// and blank lines until at least one freq row has been seen — but only
	// for a bounded number of lines.
	if len(r.freqs) == 0 {
		if r.preambleExhausted() {
			return lineFallthrough
		}
		return lineConsumed
	}
	if trimmed == "" {
		return lineConsumed // single blank lines inside the block
	}
	// Non-blank, non-matching line after rows means block ended.
	// Don't emit yet — wait for IR SPECTRUM section to attach intensities.
	r.pendingFreqs = append(r.pendingFreqs[:0], r.freqs...)
	r.pendingHessIdx = r.hessCount
	r.freqs = r.freqs[:0]
	r.resetIdle()
	return lineFallthrough
}

func (r *parseRun) handleIRSpectrumLine(line string) lineOutcome {
	if m := reIRRow.FindStringSubmatch(line); m != nil {
		idx, idxOk := parseInt(m[1])
		intensity, intOk := parseFloat(m[2])
		if !idxOk || !intOk {
			return lineConsumed
		}
		r.irIntensities[idx] = intensity
		return lineConsumed
	}
	trimmed := strings.TrimSpace(line)
	if len(r.irIntensities) == 0 {
		// Tolerant of header/decorator lines before the first data row.
		if r.preambleExhausted() {
			return lineFallthrough
		}
		return lineConsumed
	}
	if trimmed == "" {
		return lineConsumed
	}
	// Block ended — flush frequencies with IR intensities attached
	if !r.flushFreqs() {
		return lineAborted
	}
	r.resetIdle()
	return lineFallthrough
}

func (r *parseRun) handleNMRShieldingLine(line string) lineOutcome {
	if m := reNMRRow.FindStringSubmatch(line); m != nil {
		idx, idxOk := parseInt(m[1])
		iso, isoOk := parseFloat(m[3])
		aniso, anisoOk := parseFloat(m[4])
		if !idxOk || !isoOk || !anisoOk {
			return lineConsumed
		}
		r.nmrShields = append(r.nmrShields, NMRShield{
			AtomIdx: idx, Element: m[2], Isotropic: iso, Anisotropy: aniso,
		})
		return lineConsumed
	}
	trimmed := strings.TrimSpace(line)
	if len(r.nmrShields) == 0 {
		if r.preambleExhausted() {
			return lineFallthrough
		}
		return lineConsumed
	}
	if trimmed == "" || strings.HasPrefix(trimmed, "-") {
		return lineConsumed
	}
	// Block ended
	if len(r.nmrShields) > 0 {
		if !r.emit(NMRShieldsEvent{base: base{TS: r.p.now()}, Items: append([]NMRShield(nil), r.nmrShields...)}) {
			return lineAborted
		}
	}
	r.nmrShields = r.nmrShields[:0]
	r.resetIdle()
	return lineFallthrough
}

func (r *parseRun) handleAbsSpectrumLine(line string) lineOutcome {
	// ORCA 6 first: its rows carry a transition label ("0-1A -> 1-1A")
	// that the 5.x regex cannot match, and its extra eV column shifts
	// every remaining field one to the right.
	if m := reAbsRow6.FindStringSubmatch(line); m != nil {
		idx, ok1 := parseInt(m[1])
		energyEV, ok2 := parseFloat(m[2])
		energyCM, ok3 := parseFloat(m[3])
		wavelength, ok4 := parseFloat(m[4])
		fosc, ok5 := parseFloat(m[5])
		if !ok1 || !ok2 || !ok3 || !ok4 || !ok5 {
			return lineConsumed
		}
		r.absSpectrumRows = append(r.absSpectrumRows, ExcitedState{
			Index:        idx,
			EnergyCM:     energyCM,
			WavelengthNM: wavelength,
			EnergyEV:     energyEV,
			OscStrength:  fosc,
		})
		return lineConsumed
	}
	if m := reAbsRow.FindStringSubmatch(line); m != nil {
		idx, ok1 := parseInt(m[1])
		energyCM, ok2 := parseFloat(m[2])
		wavelength, ok3 := parseFloat(m[3])
		fosc, ok4 := parseFloat(m[4])
		if !ok1 || !ok2 || !ok3 || !ok4 {
			return lineConsumed
		}
		r.absSpectrumRows = append(r.absSpectrumRows, ExcitedState{
			Index:        idx,
			EnergyCM:     energyCM,
			WavelengthNM: wavelength,
			EnergyEV:     energyCM * 1.23984e-4,
			OscStrength:  fosc,
		})
		return lineConsumed
	}
	trimmed := strings.TrimSpace(line)
	// Tolerate header/decorator lines before first data row.
	if len(r.absSpectrumRows) == 0 {
		if r.preambleExhausted() {
			return lineFallthrough
		}
		return lineConsumed
	}
	if trimmed == "" || strings.HasPrefix(trimmed, "-") {
		return lineConsumed
	}
	// Block ended — merge with any transition data from TD-DFT states
	r.resetIdle()
	return lineFallthrough
}

func (r *parseRun) handleTDDFTStatesLine(line string) lineOutcome {
	trimmed := strings.TrimSpace(line)
	if m := reTDDFTStateHeader.FindStringSubmatch(line); m != nil {
		if r.currentTDState != nil {
			r.excitedStates = append(r.excitedStates, *r.currentTDState)
		}
		idx, ok1 := parseInt(m[1])
		ev, ok2 := parseFloat(m[2])
		cm, ok3 := parseFloat(m[3])
		if !ok1 || !ok2 || !ok3 {
			return lineConsumed
		}
		wl := 0.0
		if cm > 0 {
			wl = 1e7 / cm
		}
		r.currentTDState = &ExcitedState{
			Index:        idx,
			EnergyEV:     ev,
			EnergyCM:     cm,
			WavelengthNM: wl,
		}
		return lineConsumed
	}
	if r.currentTDState != nil {
		if m := reOrbTransition.FindStringSubmatch(line); m != nil {
			coeff, coeffOk := parseFloat(m[3])
			if !coeffOk {
				return lineConsumed
			}
			r.currentTDState.Transitions = append(r.currentTDState.Transitions, OrbitalTransition{
				From:  m[1],
				To:    m[2],
				Coeff: coeff,
			})
			return lineConsumed
		}
	}
	if trimmed == "" {
		return lineConsumed
	}
	if strings.HasPrefix(trimmed, "-") {
		return lineConsumed
	}
	// Block ended
	if r.currentTDState != nil {
		r.excitedStates = append(r.excitedStates, *r.currentTDState)
		r.currentTDState = nil
	}
	r.resetIdle()
	return lineFallthrough
}

func (r *parseRun) flushFreqs() bool {
	if len(r.pendingFreqs) == 0 {
		return true
	}
	out := make([]Frequency, len(r.pendingFreqs))
	copy(out, r.pendingFreqs)
	for i := range out {
		if v, ok := r.irIntensities[out[i].Idx]; ok {
			out[i].IRIntensity = v
		}
	}
	r.pendingFreqs = r.pendingFreqs[:0]
	r.irIntensities = map[int]float64{}
	return r.emit(FrequenciesEvent{base: base{TS: r.p.now()}, Items: out, HessIdx: r.pendingHessIdx})
}

func isScfTablePreamble(line string) bool {
	return strings.HasPrefix(line, "---") ||
		strings.HasPrefix(line, "***") ||
		strings.HasPrefix(line, "Iteration") ||
		strings.Contains(line, "D-I-I-S") ||
		strings.Contains(line, "S-O-S-C-F")
}

// mergeExcitedStates combines absorption spectrum rows (which have fosc +
// wavelength) with TD-DFT state blocks (which have orbital transitions).
// The absorption table is the authoritative source for energies and fosc;
// the TD-DFT states add transition detail.
func mergeExcitedStates(abs []ExcitedState, tddft []ExcitedState) []ExcitedState {
	if len(abs) == 0 && len(tddft) == 0 {
		return nil
	}
	if len(abs) == 0 {
		return tddft
	}
	tddftByIdx := make(map[int]*ExcitedState, len(tddft))
	for i := range tddft {
		tddftByIdx[tddft[i].Index] = &tddft[i]
	}
	result := make([]ExcitedState, len(abs))
	for i, a := range abs {
		result[i] = a
		if td, ok := tddftByIdx[a.Index]; ok {
			result[i].Transitions = td.Transitions
		}
	}
	return result
}

// buildXYZ renders atoms in standard XYZ format consumed by 3Dmol.
func buildXYZ(atoms []Atom, cycle int) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%d\n", len(atoms))
	fmt.Fprintf(&b, "cycle %d\n", cycle)
	for _, a := range atoms {
		fmt.Fprintf(&b, "%-2s %15.8f %15.8f %15.8f\n", a.Symbol, a.X, a.Y, a.Z)
	}
	return b.String()
}
