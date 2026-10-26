package restart

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/nkls-ai/dftstream/internal/inputbuild"
	"github.com/nkls-ai/dftstream/internal/inputparse"
	"github.com/nkls-ai/dftstream/internal/parser"
)

// FixAction is what `dftstream restart` does with one classified run.
// There is exactly one decision path (Decide): the parser's run-level
// ErrorClass verdict first, then the geometric OK/IMAG/FREQ_BROKE/
// OPT_BROKE triage for whatever the verdict leaves open.
type FixAction int

const (
	// ActionNone: the run finished cleanly — nothing to restart.
	ActionNone FixAction = iota
	// ActionKickImag: minimum landed with imaginary modes (or wrong count
	// for a TS) — kick the geometry along the mode, rerun Opt Freq.
	ActionKickImag
	// ActionFreqRestart: the optimization converged but the run died
	// afterwards — Freq-only rerun from the converged geometry.
	ActionFreqRestart
	// ActionOptRestart: the optimizer never converged (crash or max
	// cycles) — restart Opt Freq from the last geometry, carrying the
	// wavefunction (MORead) when the parent .gbw exists.
	ActionOptRestart
	// ActionFixSCF: staged SCF-convergence fix (SlowConv/MaxIter first,
	// then damping or level shift chosen from the energy trace).
	ActionFixSCF
	// ActionFixMemory: raise %maxcore with the 75%-of-RAM planning rule.
	ActionFixMemory
	// ActionFixStability: unstable wavefunction — go unrestricted and let
	// the stability analysis reconverge onto the stable solution.
	ActionFixStability
	// ActionRerunTransient: environmental failure (disk, dead module,
	// unclassified abort) with no completed work to keep — rerun as-is;
	// -f/--force writes the same job with the restart wavefunction.
	ActionRerunTransient
	// ActionNotFixable: the input itself is wrong (charge/mult parity,
	// missing basis, rejected input, exploded structure) — no mechanical
	// rewrite is honest; a human has to fix it.
	ActionNotFixable
)

func (a FixAction) String() string {
	switch a {
	case ActionNone:
		return "none"
	case ActionKickImag:
		return "kick-imaginary-mode"
	case ActionFreqRestart:
		return "freq-restart"
	case ActionOptRestart:
		return "opt-restart"
	case ActionFixSCF:
		return "fix-scf"
	case ActionFixMemory:
		return "fix-memory"
	case ActionFixStability:
		return "fix-stability"
	case ActionRerunTransient:
		return "rerun-transient"
	default:
		return "not-fixable"
	}
}

// Decide maps the run-level verdict onto the action. class comes from
// DiagnoseOutput (the parser's landmark rules); the Analysis supplies the
// geometric facts the transient classes need to decide whether any
// completed work can be kept.
func Decide(class parser.ErrorClass, a Analysis, optJob, expectTS bool) FixAction {
	switch class {
	case "":
		return triageAction(a, optJob, expectTS)
	case parser.ErrorClassOptMaxCycles:
		return ActionOptRestart
	case parser.ErrorClassSCFNotConverged:
		return ActionFixSCF
	case parser.ErrorClassOutOfMemory:
		return ActionFixMemory
	case parser.ErrorClassUnstableWavefunction:
		return ActionFixStability
	case parser.ErrorClassDiskOrScratch,
		parser.ErrorClassExternalToolFailed,
		parser.ErrorClassUnknown:
		// Transient / environmental: keep whatever the triage can keep
		// (a converged optimization, a frequency verdict); with nothing
		// to keep the honest answer is "rerun as-is".
		switch act := triageAction(a, optJob, expectTS); act {
		case ActionFreqRestart, ActionKickImag:
			return act
		case ActionOptRestart:
			if len(a.LastGeometry) > 0 {
				return act
			}
			return ActionRerunTransient
		default:
			// ActionNone: the banner lies — a module died even though
			// ORCA printed "TERMINATED NORMALLY". Rerunning is still
			// needed.
			return ActionRerunTransient
		}
	default:
		// charge_mult_impossible, basis_or_ecp_missing, input_error,
		// geometry_exploded — and any class a newer parser adds that this
		// build has no fix recipe for.
		return ActionNotFixable
	}
}

// triageAction is the geometric OK/IMAG/FREQ_BROKE/OPT_BROKE triage,
// expressed as an action.
func triageAction(a Analysis, optJob, expectTS bool) FixAction {
	switch Classify(a, optJob, expectTS) {
	case ClassOK:
		return ActionNone
	case ClassImag:
		return ActionKickImag
	case ClassFreqBroke:
		return ActionFreqRestart
	default:
		return ActionOptRestart
	}
}

// ---------------------------------------------------------------------------
// Fix builders
// ---------------------------------------------------------------------------

// Fix is one generated corrective input, before rendering.
type Fix struct {
	// Keywords is the complete '!' line of the generated input.
	Keywords []string
	// Blocks are raw `%… end` block texts, rendered after the resources.
	Blocks []string
	// Comments are ORCA-inert '#' lines describing the change, rendered
	// under the provenance comment. ASCII only — inputlint rejects
	// non-ASCII input files.
	Comments []string
	// Notes are the CLI's short what-changed-and-why lines (stderr only).
	Notes []string
	// MaxCoreMB overrides the parent's %maxcore when > 0.
	MaxCoreMB int
}

// SCFFix builds the staged SCF-convergence fix, keeping the job keywords
// otherwise unchanged:
//
//	stage 1  no SlowConv-family keyword yet → SlowConv + %scf MaxIter 500
//	stage 2  stage 1 already applied → VerySlowConv + MaxIter 1000, plus
//	         a level shift when the energy trace oscillates (occupation
//	         flipping between near-degenerate solutions) or damping when
//	         it descends steadily (convergence is real but slow).
//
// The stage is detected from the keywords themselves, so restarting a
// restart escalates instead of stacking duplicates.
func SCFFix(kws []string, trend SCFTrend) Fix {
	if !hasToken(kws, "SLOWCONV") && !hasToken(kws, "VERYSLOWCONV") {
		return Fix{
			Keywords: appendUnique(kws, "SlowConv"),
			Blocks:   []string{"%scf\n  MaxIter 500\nend"},
			Comments: []string{"# dftstream restart: SCF fix stage 1 - SlowConv + MaxIter 500 (restart again for stage 2 if this also fails)"},
			Notes: []string{
				"stage 1: added SlowConv and raised the SCF iteration cap to 500",
				"if this restart fails to converge too, restart it again for the stage-2 fix (damping or level shift, chosen from the energy trace)",
			},
		}
	}

	out := appendUnique(removeTokens(kws, "SLOWCONV"), "VerySlowConv")
	switch trend {
	case TrendOscillating:
		return Fix{
			Keywords: out,
			Blocks:   []string{"%scf\n  MaxIter 1000\n  Shift Shift 0.3 ErrOff 0 end\nend"},
			Comments: []string{"# dftstream restart: SCF fix stage 2 - energy was oscillating (occupation flipping between near-degenerate solutions): VerySlowConv + static level shift"},
			Notes: []string{
				"stage 2: the SCF energy was oscillating - the occupation is flipping between near-degenerate solutions",
				"added VerySlowConv and a static level shift (%scf Shift Shift 0.3 ErrOff 0), MaxIter 1000",
			},
		}
	case TrendDescending:
		return Fix{
			Keywords: out,
			Blocks:   []string{"%scf\n  MaxIter 1000\n  Damp Fac 0.95 ErrOff 0 end\nend"},
			Comments: []string{"# dftstream restart: SCF fix stage 2 - energy was still descending (convergence real but slow): VerySlowConv + strong damping"},
			Notes: []string{
				"stage 2: the SCF energy was still descending - convergence is real, it just ran out of iterations",
				"added VerySlowConv and strong damping (%scf Damp Fac 0.95 ErrOff 0), MaxIter 1000",
			},
		}
	default:
		return Fix{
			Keywords: out,
			Blocks:   []string{"%scf\n  MaxIter 1000\nend"},
			Comments: []string{"# dftstream restart: SCF fix stage 2 - no usable SCF trace in the output: VerySlowConv + MaxIter 1000"},
			Notes: []string{
				"stage 2: escalated to VerySlowConv with MaxIter 1000 (the output had too little SCF trace to tell oscillation from slow descent)",
			},
		}
	}
}

// MemoryFix raises %maxcore to the documented planning figure — 75% of
// the machine's RAM divided by the parallel processes, whole GB per core
// (inputbuild.MaxCoreMB, the same rule inputlint's RAM check warns with).
// nprocs is preserved. ok=false when the machine's RAM already caps the
// request: emitting a bigger number would just move the OOM kill later.
func MemoryFix(kws []string, curMaxCoreMB, nprocs, totalRAMMB int) (Fix, bool) {
	procs := nprocs
	if procs <= 0 {
		procs = 1
	}
	target := inputbuild.MaxCoreMB(totalRAMMB, procs)
	if target <= 0 || (curMaxCoreMB > 0 && target <= curMaxCoreMB) {
		return Fix{}, false
	}
	from := "unset"
	if curMaxCoreMB > 0 {
		from = fmt.Sprintf("%d MB", curMaxCoreMB)
	}
	return Fix{
		Keywords:  kws,
		MaxCoreMB: target,
		Comments: []string{fmt.Sprintf(
			"# dftstream restart: raised %%maxcore %s -> %d MB (75%% of %d MB RAM / %d procs; the 25%% headroom absorbs ORCA's transient overshoots)",
			from, target, totalRAMMB, procs)},
		Notes: []string{fmt.Sprintf(
			"raised %%maxcore from %s to %d MB: 75%% of this machine's %.1f GB RAM across %d process(es)",
			from, target, float64(totalRAMMB)/1024, procs)},
	}, true
}

// MemoryCapNote explains why MemoryFix refused: the request is already at
// the planning ceiling for this machine.
func MemoryCapNote(curMaxCoreMB, nprocs, totalRAMMB int) string {
	procs := nprocs
	if procs <= 0 {
		procs = 1
	}
	if totalRAMMB <= 0 {
		return "this machine's RAM could not be determined, so a safe %maxcore cannot be computed - set %maxcore to 75% of the target node's RAM divided by nprocs"
	}
	return fmt.Sprintf(
		"%%maxcore %d MB x %d proc(s) is already at the 75%% planning ceiling of this machine's %.1f GB RAM - raising it further would just move the OOM kill later. Run fewer processes (lower %%pal nprocs) so each one gets more room, or move to a bigger node",
		curMaxCoreMB, procs, float64(totalRAMMB)/1024)
}

// StabilityFix rewrites the job unrestricted and turns the stability
// analysis into a self-healing one: StabPerform finds the lower solution,
// StabRestartUHFifUnstable reconverges onto it. Restricted spin tags are
// dropped so the generated input cannot contradict itself.
func StabilityFix(kws []string, summary inputparse.Summary) Fix {
	out := removeTokens(kws, "RHF", "RKS", "ROHF", "ROKS")
	spin := "UKS"
	if summary.Functional == "" && summary.Method == "HF" {
		spin = "UHF"
	}
	if !hasToken(out, "UKS") && !hasToken(out, "UHF") {
		out = appendUnique(out, spin)
	}
	return Fix{
		Keywords: out,
		Blocks:   []string{"%scf\n  StabPerform true\n  StabRestartUHFifUnstable true\nend"},
		Comments: []string{"# dftstream restart: unstable wavefunction - run unrestricted and let the stability analysis reconverge onto the stable solution; check <S**2> for spin contamination"},
		Notes: []string{
			"the converged wavefunction was a saddle point of the SCF equations, not a minimum",
			fmt.Sprintf("running unrestricted (%s) with %%scf StabPerform + StabRestartUHFifUnstable so ORCA follows the instability to the stable solution", spin),
			"check <S**2> in the new output for spin contamination",
		},
	}
}

// TransientFix regenerates the same job for an environment-class failure
// (disk/scratch, dead module, unclassified abort): keywords unchanged,
// restart wavefunction added by the caller via WithMORead.
func TransientFix(kws []string) Fix {
	return Fix{
		Keywords: kws,
		Comments: []string{"# dftstream restart: transient failure - same job regenerated (fix the environment before resubmitting)"},
		Notes:    []string{"the failure looks environmental, not chemical - the job itself is unchanged"},
	}
}

// WithMORead makes the fix read the parent run's wavefunction: the MORead
// keyword plus a %moinp block naming gbwFile (a base name — the restart
// input is written next to the parent's .gbw). An empty gbwFile is a
// no-op. ORCA's Autostart cannot do this on its own: it looks for
// <restart-stem>.gbw, which does not exist yet.
func WithMORead(f Fix, gbwFile string) Fix {
	if gbwFile == "" {
		return f
	}
	f.Keywords = appendUnique(f.Keywords, "MORead")
	f.Blocks = append(f.Blocks, fmt.Sprintf("%%moinp %q", gbwFile))
	f.Notes = append(f.Notes, fmt.Sprintf("reading the previous wavefunction from %s (MORead), so converged SCF work is kept", gbwFile))
	return f
}

// RenderFix renders the corrected input: provenance + fix comments, the
// keyword line, the parent's resources (with the fix's %maxcore override,
// if any), the fix blocks, and the structure. Always a NEW file — the
// parent's own files are never touched.
func RenderFix(summary inputparse.Summary, fix Fix, structure inputbuild.Structure, prov string) string {
	env, res := inputbuild.FromSummary(summary)
	if fix.MaxCoreMB > 0 {
		res.MaxCoreMB = fix.MaxCoreMB
	}
	var comments []string
	if prov != "" {
		comments = append(comments, prov)
	}
	comments = append(comments, fix.Comments...)
	blocks := make([]inputbuild.Block, 0, len(fix.Blocks))
	for _, b := range fix.Blocks {
		blocks = append(blocks, inputbuild.RawBlock(b))
	}
	return inputbuild.Input{
		Comments:  comments,
		Keywords:  fix.Keywords,
		Env:       env,
		Res:       res,
		Blocks:    blocks,
		Structure: structure,
	}.Render()
}

// ---------------------------------------------------------------------------
// Structure fallback
// ---------------------------------------------------------------------------

var (
	reInpCoordHeader = regexp.MustCompile(`(?im)^\s*\*\s*(xyz|xyzfile|gzmt|int)\s+(-?\d+)\s+(\d+)\s*(\S*)`)
	reInpAtomRow     = regexp.MustCompile(`^\s*([A-Za-z]{1,2})\s+([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s+([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s+([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*$`)
)

// StructureFromInput recovers the parent input's own coordinate section,
// for runs that died before printing any CARTESIAN COORDINATES block (an
// input-stage OOM, an SCF that never finished its first cycle). Inline
// `* xyz` blocks come back as a Geometry; `* xyzfile` references stay
// references (the restart is written next to the parent, so a relative
// path keeps resolving). ok=false for gzmt/int internal-coordinate
// blocks, which have no cartesian rows to carry over.
func StructureFromInput(text string) (inputbuild.Structure, bool) {
	m := reInpCoordHeader.FindStringSubmatch(text)
	if m == nil {
		return nil, false
	}
	switch strings.ToLower(m[1]) {
	case "xyzfile":
		if m[4] == "" {
			return nil, false
		}
		return inputbuild.XYZFile(m[4]), true
	case "xyz":
		lines := strings.Split(text, "\n")
		start := -1
		for i, line := range lines {
			if reInpCoordHeader.MatchString(line) {
				start = i + 1
				break
			}
		}
		if start < 0 {
			return nil, false
		}
		var atoms []Atom
		for _, line := range lines[start:] {
			t := strings.TrimSpace(line)
			if strings.HasPrefix(t, "*") {
				break
			}
			if t == "" {
				continue
			}
			am := reInpAtomRow.FindStringSubmatch(line)
			if am == nil {
				break
			}
			x, errX := strconv.ParseFloat(am[2], 64)
			y, errY := strconv.ParseFloat(am[3], 64)
			z, errZ := strconv.ParseFloat(am[4], 64)
			if errX != nil || errY != nil || errZ != nil {
				break // malformed row terminates the block
			}
			atoms = append(atoms, Atom{El: am[1], X: x, Y: y, Z: z})
		}
		if len(atoms) == 0 {
			return nil, false
		}
		return inputbuild.Geometry(atoms), true
	default:
		return nil, false
	}
}

// ---------------------------------------------------------------------------
// Keyword helpers (case-insensitive; ORCA keywords are)
// ---------------------------------------------------------------------------

func hasToken(kws []string, up string) bool {
	for _, k := range kws {
		if strings.EqualFold(k, up) {
			return true
		}
	}
	return false
}

// appendUnique adds tok unless an equal token (case-insensitive) is
// already present — the dedupe that keeps restart-of-a-restart inputs
// from stacking keywords.
func appendUnique(kws []string, tok string) []string {
	if hasToken(kws, tok) {
		return kws
	}
	out := make([]string, 0, len(kws)+1)
	out = append(out, kws...)
	return append(out, tok)
}

func removeTokens(kws []string, ups ...string) []string {
	out := make([]string, 0, len(kws))
	for _, k := range kws {
		drop := false
		for _, up := range ups {
			if strings.EqualFold(k, up) {
				drop = true
				break
			}
		}
		if !drop {
			out = append(out, k)
		}
	}
	return out
}
