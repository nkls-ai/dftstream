package restart

import "github.com/nkls-ai/dftstream/internal/parser"

// ClassInfo is the CLI-facing diagnosis for one parser.ErrorClass: a
// condensed Go-side mirror of the table in ui/src/lib/diagnosis.ts
// (DIAGNOSES). The prose is deliberately short — the UI carries the full
// explanation; the CLI needs one headline, one cause, one next step.
//
// Coverage is pinned by a test against parser.AllErrorClasses, so a class
// added to the parser without an entry (and an action in Decide) fails
// the build's tests instead of silently printing nothing.
type ClassInfo struct {
	// Title is the one-line headline (mirrors diagnosis.ts `title`).
	Title string
	// Cause is the condensed plain-English cause (mirrors `cause`).
	Cause string
	// Hint names the next step for a human. For classes restart fixes
	// automatically it is empty — the fix speaks for itself.
	Hint string
}

// manualTroubleshootingURL matches MANUAL_TROUBLESHOOTING_LINK in
// ui/src/lib/diagnosis.ts.
const manualTroubleshootingURL = "https://orca-manual.mpi-muelheim.mpg.de/contents/quickstartguide/troubleshooting.html"

var classInfos = map[parser.ErrorClass]ClassInfo{
	parser.ErrorClassSCFNotConverged: {
		Title: "The SCF did not converge",
		Cause: "the self-consistent field iterations never met the threshold, so no wavefunction (and no energy) exists for this geometry",
	},
	parser.ErrorClassOptMaxCycles: {
		Title: "The optimization ran out of cycles before converging",
		Cause: "the optimizer hit its cycle limit; the final structure is not a stationary point (ORCA still prints TERMINATED NORMALLY on such runs)",
	},
	parser.ErrorClassOutOfMemory: {
		Title: "The run ran out of memory",
		Cause: "%maxcore is a planning figure, not a limit - the total request is %maxcore x nprocs, and correlated steps transiently overshoot it",
	},
	parser.ErrorClassDiskOrScratch: {
		Title: "The scratch directory or disk failed",
		Cause: "the run could not write its temporary files: disk full, quota exceeded, or the scratch directory unavailable",
		Hint:  "free space or quota on the scratch filesystem, or use `dftstream submit` to stage the job onto node-local scratch",
	},
	parser.ErrorClassGeometryExploded: {
		Title: "The structure fell apart during optimization",
		Cause: "atoms drifted apart or collapsed until ORCA could no longer build internal coordinates; the last geometries are already unphysical, so restarting from them will not help",
		Hint:  "inspect the starting structure and its units (Bohr/Angstrom mix-ups are the classic), verify charge and multiplicity, and cap fragile steps with %geom MaxStep 0.1 end",
	},
	parser.ErrorClassChargeMultImpossible: {
		Title: "The charge and multiplicity cannot both be right",
		Cause: "the electron count and the requested multiplicity have the wrong parity - the state cannot exist for that electron count",
		Hint:  "recount the electrons and fix the `* xyz <charge> <multiplicity>` header; `dftstream lint` checks the parity without running ORCA",
	},
	parser.ErrorClassUnstableWavefunction: {
		Title: "The converged wavefunction is not the stable one",
		Cause: "the stability analysis found a lower solution and reconvergence failed - typically restricted treatment of biradical character or a stretched bond",
	},
	parser.ErrorClassBasisOrECPMissing: {
		Title: "No basis set or ECP for one of your elements",
		Cause: "the chosen basis has no parameters (or no ECP) for at least one element in the structure",
		Hint:  "switch to a family that covers every element (def2-SVP / def2-TZVP span H-Rn with automatic def2-ECP) or assign a per-element basis in a %basis block; then re-run `dftstream lint`",
	},
	parser.ErrorClassExternalToolFailed: {
		Title: "An ORCA module or external program died",
		Cause: "an auxiliary step terminated with an error mid-run (ORCA can still print TERMINATED NORMALLY afterwards); everything completed before it is intact",
	},
	parser.ErrorClassInputError: {
		Title: "ORCA rejected the input file",
		Cause: "the input never made it past parsing - a misspelled keyword, an unclosed % block, or options that cannot be combined; no chemistry happened",
		Hint:  "run `dftstream lint` on the input to iterate on the fix in seconds, and check the quoted line against the manual: " + manualTroubleshootingURL,
	},
	parser.ErrorClassUnknown: {
		Title: "The run failed for an unrecognized reason",
		Cause: "the run terminated abnormally but no known failure pattern appears - commonly a walltime kill, a drained node, or a by-hand kill",
		Hint:  "read the tail of the .out; the last lines before the silence usually say which step was underway",
	},
}

// ClassInfoFor returns the CLI diagnosis for a class; ok is false for the
// empty class and for classes from a newer parser this build predates.
func ClassInfoFor(c parser.ErrorClass) (ClassInfo, bool) {
	info, ok := classInfos[c]
	return info, ok
}
