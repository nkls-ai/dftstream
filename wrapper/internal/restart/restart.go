// Package restart builds resubmission inputs for broken ORCA runs.
//
// It ports the group's battle-tested triage flow (resubmit_broken.py):
// classify a finished .out as OK / IMAG / FREQ_BROKE / OPT_BROKE and
// generate a fresh input from the run's own settings —
//
//	IMAG        minimum landed with imaginary modes → kick the geometry
//	            along the imaginary normal mode and re-run Opt Freq
//	FREQ_BROKE  the optimization converged but the run died afterwards
//	            (typically in the frequency step) → re-run Freq only,
//	            from the converged geometry
//	OPT_BROKE   the optimizer never converged (crash or max cycles) →
//	            restart Opt Freq from the last geometry
//
// The .out is only ever read; the restart input is written as a NEW file.
package restart

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"

	"github.com/nkls-ai/dftstream/internal/inputbuild"
	"github.com/nkls-ai/dftstream/internal/inputparse"
)

// Atom is one cartesian coordinate row. Aliased onto the typed input
// model so geometries pass between the analyzer and the renderer
// without conversion.
type Atom = inputbuild.Atom

type ImagMode struct {
	Index  int
	FreqCM float64
}

// Analysis is everything the classifier and builder need from one .out.
type Analysis struct {
	Terminated   bool
	OptConverged bool
	ImagModes    []ImagMode
	LastGeometry []Atom
	// NormalModes maps mode index → 3N cartesian displacement vector
	// (x0 y0 z0 x1 y1 z1 …), from the NORMAL MODES matrix.
	NormalModes map[int][]float64

	// NEB band phase, when the output contains one. NEB runs pre-optimize
	// their endpoints, printing the plain opt-converged banner before the
	// band — so for them only OptConvergedPostNEB (the final TS
	// optimization of an NEB-TS) is run-level convergence.
	NEBBand             bool // "NEB OPTIMIZATION" section present
	NEBConverged        bool // the band reached a MEP
	OptConvergedPostNEB bool
}

// ForNEBRun returns a copy whose OptConverged reflects only the post-band
// TS optimization, making the standard Classify matrix correct for NEB
// runs.
func (a Analysis) ForNEBRun() Analysis {
	a.OptConverged = a.OptConvergedPostNEB
	return a
}

type Class string

const (
	ClassOK        Class = "OK"
	ClassImag      Class = "IMAG"
	ClassFreqBroke Class = "FREQ_BROKE"
	ClassOptBroke  Class = "OPT_BROKE"
)

var (
	reLastGeomHeader = regexp.MustCompile(`CARTESIAN COORDINATES \(ANGSTROEM\)`)
	reGeomAtom       = regexp.MustCompile(`^\s*([A-Z][a-z]?)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s*$`)
	reFreqRow        = regexp.MustCompile(`^\s*(\d+):\s+(-?\d+\.\d+)\s+cm\*\*-1`)
	reModeFloat      = regexp.MustCompile(`-?\d+\.\d+`)
)

// AnalyzeOutput extracts termination, convergence, imaginary modes, the
// last geometry, and the normal-mode matrix from the full .out text.
func AnalyzeOutput(text string) Analysis {
	a := Analysis{
		Terminated:   strings.Contains(text, "ORCA TERMINATED NORMALLY"),
		OptConverged: strings.Contains(text, "THE OPTIMIZATION HAS CONVERGED"),
		NormalModes:  map[int][]float64{},
	}
	if idx := strings.Index(text, "NEB OPTIMIZATION"); idx >= 0 {
		a.NEBBand = true
		a.NEBConverged = strings.Contains(text, "THE NEB OPTIMIZATION HAS CONVERGED")
		a.OptConvergedPostNEB = strings.Contains(text[idx:], "THE OPTIMIZATION HAS CONVERGED")
	}

	a.ImagModes = ImagModesInLastFreqSection(text)
	a.LastGeometry = lastGeometry(text)
	a.NormalModes = parseNormalModes(text)
	return a
}

// ImagModesInLastFreqSection returns the imaginary modes of the LAST
// "VIBRATIONAL FREQUENCIES" section only, so stale entries from
// Recalc_Hess sections earlier in an opt don't leak in. A row counts as
// imaginary when its wavenumber is negative or it carries ORCA's
// ***imaginary mode*** marker (ORCA prints both together; accepting
// either keeps the classifier robust to formatting drift). Shared by
// the restart classifier and the runner's post-processing.
func ImagModesInLastFreqSection(text string) []ImagMode {
	idx := strings.LastIndex(text, "VIBRATIONAL FREQUENCIES")
	if idx < 0 {
		return nil
	}
	var out []ImagMode
	for _, line := range strings.Split(text[idx:], "\n") {
		im := reFreqRow.FindStringSubmatch(line)
		if im == nil {
			continue
		}
		modeIdx, err1 := strconv.Atoi(im[1])
		freq, err2 := strconv.ParseFloat(im[2], 64)
		if err1 != nil || err2 != nil {
			continue // malformed row — skip
		}
		if freq < 0 || strings.Contains(strings.ToLower(line), "imaginary") {
			out = append(out, ImagMode{Index: modeIdx, FreqCM: freq})
		}
	}
	return out
}

func lastGeometry(text string) []Atom {
	locs := reLastGeomHeader.FindAllStringIndex(text, -1)
	if locs == nil {
		return nil
	}
	tail := text[locs[len(locs)-1][1]:]
	var atoms []Atom
	started := false
	for _, line := range strings.Split(tail, "\n") {
		m := reGeomAtom.FindStringSubmatch(line)
		if m == nil {
			trimmed := strings.TrimSpace(line)
			// Tolerate the dashed separator / blank line before the first row.
			if !started && (trimmed == "" || strings.HasPrefix(trimmed, "-")) {
				continue
			}
			break
		}
		started = true
		x, errX := strconv.ParseFloat(m[2], 64)
		y, errY := strconv.ParseFloat(m[3], 64)
		z, errZ := strconv.ParseFloat(m[4], 64)
		if errX != nil || errY != nil || errZ != nil {
			break // malformed row terminates the block
		}
		atoms = append(atoms, Atom{El: m[1], X: x, Y: y, Z: z})
	}
	return atoms
}

// parseNormalModes reads ORCA's NORMAL MODES matrix (printed in blocks of
// up to 6 columns; rows are the 3N cartesian components). Returns mode
// index → 3N displacement vector.
func parseNormalModes(text string) map[int][]float64 {
	start := strings.LastIndex(text, "NORMAL MODES")
	if start < 0 {
		return map[int][]float64{}
	}
	section := text[start:]
	if end := strings.Index(section, "IR SPECTRUM"); end >= 0 {
		section = section[:end]
	}

	modes := map[int][]float64{}
	var cols []int
	for _, line := range strings.Split(section, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		if allInts(fields) && len(fields) <= 6 {
			cols = cols[:0]
			for _, f := range fields {
				n, err := strconv.Atoi(f)
				if err != nil {
					cols = nil
					break
				}
				cols = append(cols, n)
			}
			continue
		}
		// Data row: integer row index followed by one float per column.
		if _, err := strconv.Atoi(fields[0]); err != nil || len(cols) == 0 {
			continue
		}
		vals := reModeFloat.FindAllString(line, -1)
		if len(vals) != len(cols) {
			continue
		}
		for i, c := range cols {
			v, err := strconv.ParseFloat(vals[i], 64)
			if err != nil {
				continue
			}
			modes[c] = append(modes[c], v)
		}
	}
	return modes
}

func allInts(fields []string) bool {
	for _, f := range fields {
		if _, err := strconv.Atoi(f); err != nil {
			return false
		}
	}
	return true
}

// Classify applies the triage matrix. optJob marks runs whose input
// requests a geometry optimization; expectTS marks OptTS-style jobs,
// where exactly one imaginary mode is the SUCCESS condition. An
// unconverged optimizer always loses — imaginary modes seen without
// convergence come from an intermediate hessian at a non-stationary
// geometry and prove nothing.
func Classify(a Analysis, optJob, expectTS bool) Class {
	imagOK := len(a.ImagModes) == 0
	if expectTS {
		imagOK = len(a.ImagModes) == 1
	}
	if !optJob {
		// Pure SP/Freq job: no optimizer to converge.
		switch {
		case !a.Terminated:
			return ClassFreqBroke
		case imagOK:
			return ClassOK
		default:
			return ClassImag
		}
	}
	switch {
	case a.OptConverged && !a.Terminated:
		return ClassFreqBroke
	case !a.OptConverged:
		// Crashed mid-opt, or terminated normally after max cycles.
		return ClassOptBroke
	case imagOK:
		return ClassOK
	default:
		return ClassImag
	}
}

// Displace kicks the geometry along one normal mode, scaled so the single
// largest atomic displacement equals step (Å) — physically comparable
// kicks regardless of molecule size.
func Displace(geom []Atom, mode []float64, step float64) ([]Atom, error) {
	if len(mode) != 3*len(geom) {
		return nil, fmt.Errorf("mode vector has %d components, geometry needs %d", len(mode), 3*len(geom))
	}
	maxNorm := 0.0
	for i := range geom {
		n := math.Sqrt(mode[3*i]*mode[3*i] + mode[3*i+1]*mode[3*i+1] + mode[3*i+2]*mode[3*i+2])
		if n > maxNorm {
			maxNorm = n
		}
	}
	if maxNorm == 0 {
		return nil, fmt.Errorf("normal mode is all zeros")
	}
	scale := step / maxNorm
	out := make([]Atom, len(geom))
	for i, at := range geom {
		out[i] = Atom{
			El: at.El,
			X:  at.X + scale*mode[3*i],
			Y:  at.Y + scale*mode[3*i+1],
			Z:  at.Z + scale*mode[3*i+2],
		}
	}
	return out, nil
}

// RestartKeywords rewrites the original '!' tokens for the restart:
//   - IMAG / OPT_BROKE: keep everything, ensure an opt keyword and Freq.
//   - FREQ_BROKE: geometry is already converged — strip opt keywords,
//     ensure Freq.
//
// Opt/freq keyword classification (including opt tiers, which imply Opt)
// lives in inputparse so it cannot drift from the input parser.
func RestartKeywords(orig []string, class Class) []string {
	var out []string
	hasOpt, hasFreq := false, false
	for _, tok := range orig {
		if inputparse.IsOptKeyword(tok) {
			if class == ClassFreqBroke {
				continue
			}
			hasOpt = true
		}
		if inputparse.IsFreqKeyword(tok) {
			hasFreq = true
		}
		out = append(out, tok)
	}
	if class != ClassFreqBroke && !hasOpt {
		out = append(out, "Opt")
	}
	if !hasFreq {
		out = append(out, "Freq")
	}
	return out
}

// NEBTSRestartKeywords rewrites a NEB-TS input's '!' tokens into a plain
// OptTS restart: the NEB driver is dropped (its %neb context cannot be
// carried over) and OptTS + Freq are ensured. Used when a NEB-TS reached
// its TS phase — the saddle refinement continues as a regular OptTS.
func NEBTSRestartKeywords(orig []string) []string {
	var out []string
	hasOptTS, hasFreq := false, false
	for _, tok := range orig {
		if inputparse.IsNEBKeyword(tok) {
			continue
		}
		if strings.EqualFold(tok, string(inputparse.RunTypeOptTS)) {
			hasOptTS = true
		}
		if inputparse.IsFreqKeyword(tok) {
			hasFreq = true
		}
		out = append(out, tok)
	}
	if !hasOptTS {
		out = append(out, "OptTS")
	}
	if !hasFreq {
		out = append(out, "Freq")
	}
	return out
}

// inputFor assembles the typed input: the parent's environment and
// resources, the chosen keywords, and any extra blocks (passed verbatim
// as raw blocks — callers that have a typed block should build the
// inputbuild.Input directly).
func inputFor(summary inputparse.Summary, keywords []string, extraBlocks []string) inputbuild.Input {
	env, res := inputbuild.FromSummary(summary)
	blocks := make([]inputbuild.Block, 0, len(extraBlocks))
	for _, blk := range extraBlocks {
		blocks = append(blocks, inputbuild.RawBlock(blk))
	}
	return inputbuild.Input{Keywords: keywords, Env: env, Res: res, Blocks: blocks}
}

// BuildInput renders a complete restart input file from the chosen
// keywords and geometry. extraBlocks are emitted verbatim after the
// resource lines (e.g. a %geom Calc_Hess block for OptTS restarts).
func BuildInput(summary inputparse.Summary, keywords []string, geom []Atom, extraBlocks ...string) string {
	in := inputFor(summary, keywords, extraBlocks)
	in.Structure = inputbuild.Geometry(geom)
	return in.Render()
}

// BuildInputXYZFile is BuildInput with the structure referenced from an
// external .xyz instead of an inline coordinate block. Required for NEB:
// ORCA's band code aborts ("GBW-File <base>_im<N>.gbw not found") when the
// starting structure is given inline.
func BuildInputXYZFile(summary inputparse.Summary, keywords []string, xyzName string, extraBlocks ...string) string {
	in := inputFor(summary, keywords, extraBlocks)
	in.Structure = inputbuild.XYZFile(xyzName)
	return in.Render()
}
