package inputbuild

import "github.com/nkls-ai/dftstream/internal/inputparse"

// FromSummary lifts a parsed parent input into the typed model: its
// environment (charge / multiplicity / solvation) and resources. The
// keyword line is NOT carried over — callers decide which of the
// parent's tokens a derived job inherits (see KeywordsFor).
//
// A parent whose charge/multiplicity could not be parsed falls back to
// ORCA's own defaults (neutral singlet), which is what every generator
// did by hand before.
func FromSummary(s inputparse.Summary) (Environment, Resources) {
	env := DefaultEnvironment()
	if s.Charge != nil {
		env.Charge = *s.Charge
	}
	if s.Mult != nil {
		env.Mult = *s.Mult
	}
	if model, ok := ParseSolventModel(s.SolventModel); ok && s.Solvent != "" {
		env.Model = model
		env.Solvent = s.Solvent
	}
	return env, Resources{NProcs: s.NProcs, MaxCoreMB: s.MaxCoreMB}
}
