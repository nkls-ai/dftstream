package cli

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/nkls-ai/dftstream/internal/cliui"
	"github.com/nkls-ai/dftstream/internal/inputbuild"
	"github.com/nkls-ai/dftstream/internal/inputlint"
	"github.com/nkls-ai/dftstream/internal/inputparse"
	"github.com/nkls-ai/dftstream/internal/restart"
	"github.com/nkls-ai/dftstream/internal/runner"
	"github.com/nkls-ai/dftstream/internal/sysinfo"
)

// Distinct exit codes so scripts can tell the outcomes apart:
//
//	0  fixed/restart input written (or shown with --dry-run), or the run
//	   was clean and there is nothing to restart
//	1  I/O or internal error
//	2  usage error
//	3  not auto-fixable — the input needs a human
//	4  transient failure — rerun the input as-is (nothing written; pass
//	   -f/--force to write a restart input anyway)
const (
	restartExitNeedsHuman = 3
	restartExitTransient  = 4
)

// restartTotalRAMMB is the machine-RAM source for the out-of-memory fix;
// a variable so tests can pin it.
var restartTotalRAMMB = sysinfo.TotalRAMMB

// restartOptions holds the parsed flags and the positional target of
// `dftstream restart`.
type restartOptions struct {
	step    float64
	mode    int
	outPath string
	force   bool
	dryRun  bool
	target  string
}

// RestartCmd implements `dftstream restart <run.out>`: classify a
// finished run — the parser's failure catalogue first, the geometric
// OK/IMAG/FREQ_BROKE/OPT_BROKE triage for whatever it leaves open — and
// write a corrected, ready-to-submit input next to it.
func RestartCmd(args []string) int {
	opts, err := parseRestartFlags(args)
	if err != nil {
		return exitCodeFor(err)
	}
	outPath, stem := resolveRestartTarget(opts.target)
	outText, inpText, err := readRestartFiles(outPath, stem)
	if err != nil {
		return exitCodeFor(err)
	}

	summary := inputparse.Parse(string(inpText))
	optJob := summary.RequestsOptimization()
	expectTS := summary.RequestsTransitionState()
	nebBand := summary.RequestsNEBBand()

	analysis := restart.AnalyzeOutput(string(outText))
	if nebBand {
		// Endpoint pre-optimizations inside NEB runs print the plain
		// opt-converged banner; only the post-band TS phase counts.
		analysis = analysis.ForNEBRun()
	}
	diag := diagnoseRestartOutput(string(outText), nebBand)
	triageCls := restart.Classify(analysis, optJob, expectTS)
	action := restart.Decide(diag.Class, analysis, optJob, expectTS)

	printRestartHeading(outPath, diag, triageCls)

	switch action {
	case restart.ActionNone:
		cliui.Success(os.Stderr, "run finished cleanly — nothing to restart")
		return 0
	case restart.ActionNotFixable:
		return refuseUnfixable(diag, stem)
	case restart.ActionRerunTransient:
		if !opts.force {
			return adviseTransient(diag, stem)
		}
	}

	if code, refused := refuseNEBRestart(summary, analysis, triageCls, stem); refused {
		return code
	}

	fix, ok := composeRestartFix(action, summary, analysis, diag, triageCls, stem)
	if !ok {
		return restartExitNeedsHuman
	}
	structure, ok := restartStructure(action, analysis, string(inpText), opts)
	if !ok {
		return 1
	}

	text := restart.RenderFix(summary, fix, structure, restartProvenance(stem))
	warnGeneratedLint(text, stem)
	for _, n := range fix.Notes {
		fmt.Fprintln(os.Stderr, "  - "+n)
	}
	return writeRestartResult(text, string(inpText), stem, opts)
}

// diagnoseRestartOutput runs the .out through the parser's failure
// catalogue (the same landmark rules the live runner uses). A stream
// error degrades to the geometric triage rather than failing the command.
func diagnoseRestartOutput(outText string, nebBand bool) restart.OutputDiagnosis {
	diag, err := restart.DiagnoseOutput(outText, nebBand)
	if err != nil {
		cliui.Warning(os.Stderr, fmt.Sprintf("could not stream the output through the failure classifier: %v", err),
			"Falling back to the geometric OK/IMAG/FREQ_BROKE/OPT_BROKE triage.")
		return restart.OutputDiagnosis{}
	}
	return diag
}

// printRestartHeading prints the class line and, for a recognized error
// class, its one-line diagnosis.
func printRestartHeading(outPath string, diag restart.OutputDiagnosis, triageCls restart.Class) {
	label := string(triageCls)
	if diag.Class != "" {
		label = diag.Class.String()
	}
	cliui.Title(os.Stderr, fmt.Sprintf("%s → %s", filepath.Base(outPath), label))
	if info, ok := restart.ClassInfoFor(diag.Class); ok {
		fmt.Fprintf(os.Stderr, "%s — %s\n", info.Title, info.Cause)
	}
}

// refuseUnfixable reports a failure no mechanical rewrite can fix: print
// the diagnosis and the next step, exit with the needs-a-human code.
func refuseUnfixable(diag restart.OutputDiagnosis, stem string) int {
	hint := "Fix the input by hand — see the ORCA manual's troubleshooting chapter."
	if info, ok := restart.ClassInfoFor(diag.Class); ok && info.Hint != "" {
		hint = info.Hint
	}
	if diag.Excerpt != "" {
		fmt.Fprintln(os.Stderr, indentExcerpt(diag.Excerpt))
	}
	cliui.Error(os.Stderr, fmt.Sprintf("not auto-fixable (%s)", diag.Class), hint)
	fmt.Fprintf(os.Stderr, "check the input without running ORCA:  dftstream lint %s.inp\n", stem)
	return restartExitNeedsHuman
}

// adviseTransient reports an environmental failure with no completed work
// to keep: the right move is to fix the environment and rerun as-is.
func adviseTransient(diag restart.OutputDiagnosis, stem string) int {
	hint := ""
	if info, ok := restart.ClassInfoFor(diag.Class); ok {
		hint = info.Hint
	}
	if diag.Excerpt != "" {
		fmt.Fprintln(os.Stderr, indentExcerpt(diag.Excerpt))
	}
	cliui.Warning(os.Stderr, "transient failure — the job itself looks fine; nothing was written", hint)
	fmt.Fprintf(os.Stderr, "rerun as-is:              dftstream run %s.inp\n", stem)
	fmt.Fprintf(os.Stderr, "or write a restart input: dftstream restart -f %s.out (same job, restart wavefunction)\n", stem)
	return restartExitTransient
}

func indentExcerpt(excerpt string) string {
	lines := strings.Split(strings.TrimRight(excerpt, "\n"), "\n")
	for i := range lines {
		lines[i] = "  | " + lines[i]
	}
	return strings.Join(lines, "\n")
}

// composeRestartFix builds the per-action fix on top of the (possibly
// NEB-adjusted) parent keywords. ok=false means the fix is impossible on
// this machine and the reason was already printed.
func composeRestartFix(action restart.FixAction, summary inputparse.Summary, analysis restart.Analysis, diag restart.OutputDiagnosis, triageCls restart.Class, stem string) (restart.Fix, bool) {
	base, nebBlocks, nebNotes := nebAdjustedKeywords(summary, triageCls)
	gbw := siblingGBW(stem)

	var fix restart.Fix
	switch action {
	case restart.ActionKickImag:
		fix = restart.WithMORead(restart.Fix{
			Keywords: restart.RestartKeywords(base, restart.ClassImag),
			Notes:    []string{fmt.Sprintf("imaginary modes %s — kicking the geometry along the mode and rerunning Opt Freq", describeModes(analysis.ImagModes))},
		}, gbw)
	case restart.ActionFreqRestart:
		fix = restart.WithMORead(restart.Fix{
			Keywords: restart.RestartKeywords(base, restart.ClassFreqBroke),
			Notes:    []string{"optimization converged, run died afterwards — Freq-only rerun from the converged geometry, so no optimization work is repeated"},
		}, gbw)
	case restart.ActionOptRestart:
		fix = restart.WithMORead(restart.Fix{
			Keywords: restart.RestartKeywords(base, restart.ClassOptBroke),
			Notes:    []string{"optimizer did not converge — restarting Opt Freq from the last geometry, keeping the cycles already spent"},
		}, gbw)
	case restart.ActionFixSCF:
		fix = restart.SCFFix(base, restart.AnalyzeSCFTrend(diag.LastSCFEnergies))
	case restart.ActionFixMemory:
		var ok bool
		fix, ok = restart.MemoryFix(base, summary.MaxCoreMB, summary.NProcs, restartTotalRAMMB())
		if !ok {
			cliui.Error(os.Stderr, "cannot raise %maxcore on this machine",
				restart.MemoryCapNote(summary.MaxCoreMB, summary.NProcs, restartTotalRAMMB()))
			return restart.Fix{}, false
		}
		fix = restart.WithMORead(fix, gbw)
	case restart.ActionFixStability:
		fix = restart.StabilityFix(base, summary)
	default: // ActionRerunTransient, reached only under -f/--force
		fix = restart.WithMORead(restart.TransientFix(base), gbw)
	}
	fix.Blocks = append(nebBlocks, fix.Blocks...)
	fix.Notes = append(nebNotes, fix.Notes...)
	return fix, true
}

// nebAdjustedKeywords converts a NEB-TS input that reached its TS phase
// into a plain OptTS restart (the %neb context cannot be carried over);
// everything else passes through unchanged.
func nebAdjustedKeywords(summary inputparse.Summary, triageCls restart.Class) (kws []string, blocks, notes []string) {
	nebTS := summary.RequestsNEBBand() && summary.RequestsTransitionState()
	if !nebTS || triageCls == restart.ClassFreqBroke {
		return summary.Keywords, nil, nil
	}
	cliui.Warning(os.Stderr, "continuing the TS refinement as a plain OptTS — the NEB path context is dropped",
		"An exact initial Hessian (%geom Calc_Hess) is requested to keep the saddle search stable.")
	return restart.NEBTSRestartKeywords(summary.Keywords),
		[]string{"%geom Calc_Hess true end"},
		nil
}

// siblingGBW returns the base name of the parent run's .gbw when it
// exists next to the .out, "" otherwise. The originals are only ever
// referenced (%moinp reads them), never modified.
func siblingGBW(stem string) string {
	if _, err := os.Stat(stem + ".gbw"); err != nil {
		return "" // no restart wavefunction available — Autostart-free input
	}
	return filepath.Base(stem + ".gbw")
}

// restartStructure picks the structure for the generated input: the last
// geometry the output printed (kicked along an imaginary mode for the
// IMAG case), falling back to the parent input's own coordinates when the
// run died before printing any.
func restartStructure(action restart.FixAction, analysis restart.Analysis, inpText string, opts restartOptions) (inputbuild.Structure, bool) {
	if action == restart.ActionKickImag {
		if len(analysis.LastGeometry) == 0 {
			cliui.Error(os.Stderr, "no CARTESIAN COORDINATES block found in the output", "The run died before printing a geometry; restart from the original input instead.")
			return nil, false
		}
		return inputbuild.Geometry(chooseRestartGeometry(analysis, restart.ClassImag, opts.mode, opts.step)), true
	}
	if len(analysis.LastGeometry) > 0 {
		return inputbuild.Geometry(analysis.LastGeometry), true
	}
	if st, ok := restart.StructureFromInput(inpText); ok {
		fmt.Fprintln(os.Stderr, "the output printed no geometry — restarting from the input's own structure")
		return st, true
	}
	cliui.Error(os.Stderr, "no geometry in the output and none recoverable from the input",
		"The input's coordinate block could not be read back; fix the cause and rerun the original input.")
	return nil, false
}

// restartProvenance renders the lineage comment. Restarts chain like
// `next` outputs: the wrapper links the resubmission to the broken parent
// run at submit time.
func restartProvenance(stem string) string {
	return inputparse.Provenance{
		Edge:      "restart",
		ParentExp: runner.DefaultExperimentName(stem + ".inp"),
		ParentRun: runner.DefaultRunName(stem + ".inp"),
	}.Comment()
}

// warnGeneratedLint is a tripwire: every input restart generates must
// pass `dftstream lint` (the tests pin this); if one ever does not, that
// is a bug in restart worth reporting, not a reason to hide the file.
func warnGeneratedLint(text, stem string) {
	findings := inputlint.Lint(text, inputlint.Options{Dir: filepath.Dir(stem)})
	if !inputlint.HasErrors(findings) {
		return
	}
	cliui.Warning(os.Stderr, "the generated input does not pass `dftstream lint` — this is a bug in dftstream restart, please report it", "")
	printLintFindings(findings)
}

func parseRestartFlags(args []string) (restartOptions, error) {
	fs := flag.NewFlagSet("restart", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	step := fs.Float64("step", 0.5, "max atomic displacement in Å when kicking along an imaginary mode")
	mode := fs.Int("mode", -1, "imaginary mode index to displace along (default: the most negative one)")
	out := fs.String("o", "", "output path (default: <stem>_restart.inp next to the .out)")
	force := fs.Bool("f", false, "overwrite an existing output file, and write a restart input even for transient failures")
	fs.BoolVar(force, "force", false, "alias for -f")
	dryRun := fs.Bool("dry-run", false, "print the diff against the parent input instead of writing")
	help := fs.Bool("help", false, "show help")
	if err := fs.Parse(args); err != nil {
		return restartOptions{}, exitStatus(2)
	}
	if *help || fs.NArg() != 1 {
		restartUsage()
		if *help {
			return restartOptions{}, exitStatus(0)
		}
		return restartOptions{}, exitStatus(2)
	}
	return restartOptions{
		step:    *step,
		mode:    *mode,
		outPath: *out,
		force:   *force,
		dryRun:  *dryRun,
		target:  fs.Arg(0),
	}, nil
}

// resolveRestartTarget normalizes the positional argument to the run's
// .out path (accepting the .inp as a convenience) and derives the stem.
func resolveRestartTarget(arg string) (outPath, stem string) {
	outPath = arg
	if strings.HasSuffix(outPath, ".inp") {
		outPath = strings.TrimSuffix(outPath, ".inp") + ".out"
	}
	stem = strings.TrimSuffix(outPath, filepath.Ext(outPath))
	return outPath, stem
}

// readRestartFiles loads the run's .out and its sibling .inp.
func readRestartFiles(outPath, stem string) (outText, inpText []byte, err error) {
	outText, err = os.ReadFile(outPath)
	if err != nil {
		cliui.Error(os.Stderr, fmt.Sprintf("cannot read output file: %v", err), "Point `dftstream restart` at the run's .out file.")
		return nil, nil, exitStatus(1)
	}
	inpPath := stem + ".inp"
	inpText, err = os.ReadFile(inpPath)
	if err != nil {
		cliui.Error(os.Stderr, fmt.Sprintf("cannot read input file %s: %v", inpPath, err),
			"The restart reuses the original method/charge/mult, so the .inp must sit next to the .out.")
		return nil, nil, exitStatus(1)
	}
	return outText, inpText, nil
}

// refuseNEBRestart handles the NEB cases where synthesizing a restart
// input would be wrong: a NEB/NEB-CI (no TS phase to hand off to), or a
// NEB-TS that died before its band converged (the last printed geometry
// is just some image, not a TS candidate). Both should resume the band
// itself from ORCA's own restart file.
func refuseNEBRestart(summary inputparse.Summary, analysis restart.Analysis, class restart.Class, stem string) (int, bool) {
	if !summary.RequestsNEBBand() {
		return 0, false
	}
	tsRun := summary.RequestsTransitionState()
	if tsRun && (class == restart.ClassFreqBroke || analysis.NEBConverged) {
		return 0, false // TS phase reached — a plain OptTS/Freq restart is meaningful
	}
	msg := "the NEB band never converged — there is no TS-phase geometry to restart from"
	if !tsRun {
		msg = "a NEB run without TS refinement cannot be restarted from a single geometry"
	}
	cliui.Error(os.Stderr, msg,
		fmt.Sprintf("Resume the band itself: add to the original input\n  %%neb Restart_ALLXYZFile \"%s_MEP.allxyz\" end\nand rerun it.", filepath.Base(stem)))
	return 1, true
}

// writeRestartResult shows the diff on -dry-run, otherwise writes the
// input to the chosen destination, refusing to overwrite without -f.
func writeRestartResult(text, parentInput, stem string, opts restartOptions) int {
	dest := opts.outPath
	if dest == "" {
		dest = stem + "_restart.inp"
	}
	if opts.dryRun {
		fmt.Fprintf(os.Stdout, "--- %s\n+++ %s (dry run — nothing written)\n", stem+".inp", dest)
		fmt.Fprint(os.Stdout, restart.Diff(parentInput, text))
		return 0
	}
	if !opts.force {
		if _, err := os.Stat(dest); err == nil {
			cliui.Error(os.Stderr, fmt.Sprintf("%s already exists", dest), "Pass -f to overwrite or -o for a different path.")
			return 1
		}
	}
	if err := os.WriteFile(dest, []byte(text), 0o644); err != nil {
		cliui.Error(os.Stderr, fmt.Sprintf("cannot write restart input: %v", err), "")
		return 1
	}
	cliui.Success(os.Stderr, fmt.Sprintf("wrote %s", dest))
	fmt.Fprintf(os.Stderr, "submit with: dftstream run %s\n", dest)
	return 0
}

// chooseRestartGeometry returns the geometry to restart from: the last
// printed one, kicked along an imaginary mode for the IMAG class (with
// a fallback to the undisplaced geometry when the kick fails).
func chooseRestartGeometry(analysis restart.Analysis, class restart.Class, mode int, step float64) []restart.Atom {
	geom := analysis.LastGeometry
	if class != restart.ClassImag {
		return geom
	}
	g, kicked, err := displacedGeometry(analysis, mode, step)
	if err != nil {
		cliui.Warning(os.Stderr, fmt.Sprintf("cannot displace along imaginary mode: %v", err), "Falling back to the undisplaced last geometry.")
		return geom
	}
	fmt.Fprintf(os.Stderr, "displaced along mode %d (max atomic displacement %.2f Å)\n", kicked, step)
	return g
}

// displacedGeometry kicks the last geometry along the chosen imaginary
// mode (default: the most negative frequency). Returns the geometry and
// the mode index used.
func displacedGeometry(a restart.Analysis, mode int, step float64) ([]restart.Atom, int, error) {
	if len(a.ImagModes) == 0 {
		return nil, 0, fmt.Errorf("no imaginary modes reported")
	}
	pick := mode
	if pick < 0 {
		pick = a.ImagModes[0].Index
		for _, m := range a.ImagModes {
			if m.FreqCM < frequencyOf(a.ImagModes, pick) {
				pick = m.Index
			}
		}
	}
	vec, ok := a.NormalModes[pick]
	if !ok {
		return nil, 0, fmt.Errorf("no NORMAL MODES vector for mode %d (was the run printed with normal modes?)", pick)
	}
	g, err := restart.Displace(a.LastGeometry, vec, step)
	if err != nil {
		return nil, 0, err
	}
	return g, pick, nil
}

func frequencyOf(modes []restart.ImagMode, idx int) float64 {
	for _, m := range modes {
		if m.Index == idx {
			return m.FreqCM
		}
	}
	return 0
}

func describeModes(modes []restart.ImagMode) string {
	parts := make([]string, len(modes))
	for i, m := range modes {
		parts[i] = fmt.Sprintf("%d (%.1f cm⁻¹)", m.Index, m.FreqCM)
	}
	return strings.Join(parts, ", ")
}

func restartUsage() {
	cliui.Title(os.Stderr, "dftstream restart - build a corrected resubmission input for a broken run")
	fmt.Fprintf(os.Stderr, `
Usage:
  dftstream restart [flags] <run.out>

Reads the run's .out (and its .inp for method/charge/mult), classifies the
failure with the same rules the tracker uses, and writes <stem>_restart.inp:

  scf_not_converged       staged fix: SlowConv + MaxIter first; a second
                          restart adds a level shift (oscillating energy)
                          or damping (steady descent), read off the trace
  opt_max_cycles          Opt Freq from the last geometry, reading the
                          previous wavefunction (MORead) when the .gbw exists
  out_of_memory           %%maxcore raised to 75%% of this machine's RAM per
                          process (nprocs preserved); refuses when the RAM
                          already caps the request
  unstable_wavefunction   unrestricted (UKS/UHF) + %%scf StabPerform /
                          StabRestartUHFifUnstable
  disk_or_scratch,        transient: rerun the input as-is (exit 4);
  external_tool_failed,   completed opt work is still turned into a
  unknown                 Freq-only restart, and -f/--force writes the
                          same job with the restart wavefunction
  charge_mult_impossible, not auto-fixable: the diagnosis and the manual
  basis_or_ecp_missing,   fix are printed, exit 3 — start from
  input_error,            'dftstream lint <input.inp>'
  geometry_exploded

Runs without a recognized failure class fall back to the geometric triage:

  IMAG        imaginary modes on a minimum (or wrong count for a TS) —
              geometry kicked along the imaginary mode, rerun Opt Freq
  FREQ_BROKE  opt converged but the run died later — Freq-only restart
              from the converged geometry
  OPT_BROKE   optimizer never converged — Opt Freq from the last geometry

NEB-TS runs that reached their TS phase restart as a plain OptTS (+ exact
initial Hessian); a NEB whose band never converged is resumed with ORCA's
own %%neb Restart_ALLXYZFile mechanism instead (printed as guidance).

Every generated input is a new file with a provenance comment; the
original ORCA files are never modified.

Exit codes: 0 input written (or clean run), 1 error, 2 usage,
3 not auto-fixable (needs a human), 4 transient (rerun as-is).

Flags:
  -step float   max atomic displacement in Å for the imaginary-mode kick (default 0.5)
  -mode int     imaginary mode index to kick along (default: most negative)
  -o string     output path (default: <stem>_restart.inp)
  -f, --force   overwrite the output file if it exists; also write a
                restart input for transient failures
  -dry-run      print the diff against the parent input instead of writing
`)
}
