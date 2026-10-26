package inputbuild

import (
	"fmt"
	"strings"
)

// SolventModel is an ORCA implicit-solvation model, spelled the way it
// appears in the '!' line.
type SolventModel string

const (
	SolventNone SolventModel = ""
	// CPCM is the conductor-like polarizable continuum model — the
	// default choice for DFT geometry work.
	SolventCPCM SolventModel = "CPCM"
	// SolventCPCMHyphen is ORCA's older spelling of CPCM. It is kept as
	// its own value so a parent input's exact keyword round-trips into
	// the inputs derived from it.
	SolventCPCMHyphen SolventModel = "C-PCM"
	// SMD is Truhlar's solvation model, used for free energies of
	// solvation; ORCA implements it on top of CPCM.
	SolventSMD SolventModel = "SMD"
	// ALPB is the analytical linearized Poisson-Boltzmann model, the
	// solvation available to the xTB (GFNn-xTB) methods.
	SolventALPB SolventModel = "ALPB"
)

// ParseSolventModel resolves a model name case-insensitively. ok is
// false for anything unrecognized, so callers never invent a keyword
// ORCA will reject. "C-PCM" keeps its own spelling rather than being
// folded onto CPCM: an input derived from a parent must reproduce the
// parent's keyword exactly.
func ParseSolventModel(s string) (SolventModel, bool) {
	switch strings.ToUpper(strings.TrimSpace(s)) {
	case "":
		return SolventNone, true
	case "CPCM":
		return SolventCPCM, true
	case "C-PCM":
		return SolventCPCMHyphen, true
	case "SMD":
		return SolventSMD, true
	case "ALPB":
		return SolventALPB, true
	}
	return SolventNone, false
}

// Environment is the physical system: total charge, spin multiplicity
// (2S+1) and the implicit-solvation choice.
type Environment struct {
	Charge int
	Mult   int
	Model  SolventModel
	// Solvent is the model's solvent name, e.g. "water".
	Solvent string
}

// DefaultEnvironment is a neutral closed-shell molecule in the gas
// phase — ORCA's own defaults.
func DefaultEnvironment() Environment {
	return Environment{Charge: 0, Mult: 1}
}

// SolventKeyword renders the '!' line solvation call ("CPCM(water)"),
// or "" when the job is gas phase.
func (e Environment) SolventKeyword() string {
	if e.Model == SolventNone || e.Solvent == "" {
		return ""
	}
	return fmt.Sprintf("%s(%s)", e.Model, e.Solvent)
}

// solventPrefixes are the token prefixes that mark a solvation request.
// Prefix (not exact) matching on purpose: ORCA accepts both the bare
// model name and the parameterized call, and "CPCM" with its solvent
// given in a %cpcm block is just as much a solvated job as
// "CPCM(water)".
var solventPrefixes = []string{"CPCM", "C-PCM", "SMD", "ALPB"}

// HasSolventCall reports whether a '!' keyword list already requests
// implicit solvation, so a caller carrying a parent's solvent over does
// not add a second, conflicting model.
func HasSolventCall(keywords []string) bool {
	for _, k := range keywords {
		up := strings.ToUpper(k)
		for _, p := range solventPrefixes {
			if strings.HasPrefix(up, p) {
				return true
			}
		}
	}
	return false
}
