package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/nkls-ai/dftstream/internal/cliui"
	"github.com/nkls-ai/dftstream/internal/reimport"
	"github.com/nkls-ai/dftstream/internal/tracker"
	"github.com/nkls-ai/dftstream/internal/version"
)

// reimportPageSize bounds one reimport:listRuns page. Rows inline the run's
// whole ORCA input text, so this stays small enough to keep each query well
// inside the backend's read budget.
const reimportPageSize = 50

// reimportFlags holds the raw flag values of `dftstream reimport`.
type reimportFlags struct {
	fs         *flag.FlagSet
	experiment *string
	run        *string
	fix        *bool
	dryRun     *bool
	backend    backendFlags
}

// reimportStats tallies one sweep. Failures never abort the sweep — they are
// counted, reported per run as they happen, and decide the exit code at the
// end.
type reimportStats struct {
	scanned int // terminal runs actually re-parsed
	clean   int // no drift against the current parser
	drifted int // at least one field differs
	fixed   int // drifted runs patched (only with --fix)
	skipped int // non-terminal runs, or runs excluded by --run
	failed  int // runs whose output could not be obtained or re-parsed
}

// ReimportCmd implements `dftstream reimport [--fix]` (P0-5): re-run the
// CURRENT parser over every tracked run's stored output and report — or with
// --fix, repair — parser-derived fields that an older wrapper got wrong.
//
// Read-only toward ORCA's files by construction: outputs are read from the
// backend's stored artifact (preferred — the sweep works without local files)
// or, when that is absent or truncated, read from the original file on disk.
// Nothing is ever written to a chemist's files.
func ReimportCmd(args []string) int {
	f, err := parseReimportFlags(args)
	if err != nil {
		return exitCodeFor(err)
	}
	ct, orgID, err := openReimportClient(f.backend)
	if err != nil {
		return exitCodeFor(err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	exps, err := ct.ListExperiments(ctx, orgID)
	if err != nil {
		cliui.Error(os.Stderr, fmt.Sprintf("could not list experiments: %v", err),
			backendFixHint(err, "Make sure the backend is running."))
		return 1
	}
	exps = filterExperiments(exps, *f.experiment)
	if len(exps) == 0 {
		cliui.Warning(os.Stderr, "no matching experiments found", "")
		return 0
	}

	if *f.fix {
		cliui.Title(os.Stderr, fmt.Sprintf("reimport: repairing %d experiment(s) with parser %s", len(exps), version.String()))
	} else {
		cliui.Title(os.Stderr, fmt.Sprintf("reimport: dry-run over %d experiment(s) — reporting drift only, use --fix to repair", len(exps)))
	}

	var stats reimportStats
	for _, exp := range exps {
		if ctx.Err() != nil {
			break
		}
		if err := reimportExperiment(ctx, ct, exp, f, &stats); err != nil {
			// Per-experiment listing errors are counted, not fatal: the sweep
			// is resumable and the rest of the deployment still gets processed.
			cliui.Warning(os.Stderr, fmt.Sprintf("experiment %q: %v", exp.Name, err), "")
			stats.failed++
		}
	}

	printReimportSummary(&stats, *f.fix)
	if interrupted := ctx.Err(); interrupted != nil {
		cliui.Warning(os.Stderr, "interrupted — the sweep is resumable; re-running continues where this left off", "")
		return 1
	}
	if stats.failed > 0 {
		return 1
	}
	return 0
}

func parseReimportFlags(args []string) (reimportFlags, error) {
	fs := flag.NewFlagSet("reimport", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)

	f := reimportFlags{
		fs:         fs,
		experiment: fs.String("experiment", "", "only reimport this experiment (by name)"),
		run:        fs.String("run", "", "only reimport this run (by name; combine with --experiment to narrow further)"),
		fix:        fs.Bool("fix", false, "patch drifted rows (default: report only, change nothing)"),
		dryRun:     fs.Bool("dry-run", false, "explicitly report-only (the default; incompatible with --fix)"),
	}
	f.backend.register(fs)
	showHelp := fs.Bool("help", false, "show help")

	fs.Usage = func() {
		cliui.Title(os.Stderr, "dftstream reimport")
		fmt.Fprintf(os.Stderr, `
Usage:
  dftstream reimport [flags]

Re-runs the current parser over every tracked run's stored .out and compares
the result with what the database holds (verdicts, convergence, error class,
thermochemistry, imaginary-mode counts). Without --fix nothing is changed;
with --fix, drifted rows are patched. Only parser-derived fields are ever
touched — never notes, tags, names, status or your ORCA files.

The sweep is idempotent (a second run reports nothing) and resumable (runs
are processed in a stable order and one bad row never aborts the rest).

Flags:
`)
		fs.PrintDefaults()
	}

	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return reimportFlags{}, exitStatus(0)
		}
		return reimportFlags{}, exitStatus(2)
	}
	if *showHelp {
		fs.Usage()
		return reimportFlags{}, exitStatus(0)
	}
	if *f.fix && *f.dryRun {
		cliui.Error(os.Stderr, "--fix and --dry-run are mutually exclusive", "Drop one of them; report-only is already the default.")
		return reimportFlags{}, exitStatus(2)
	}
	return f, nil
}

// openReimportClient opens the RAW Convex tracker (no batching — reimport is
// a synchronous sweep) with stored credentials attached, and runs the same
// startup version handshake as every other network-touching subcommand.
func openReimportClient(b backendFlags) (*tracker.ConvexHTTPTracker, string, error) {
	orgID, ct, err := openConvexBackend(backendSpec{
		dsn:       b.dsn(),
		org:       b.org,
		openHint:  "Use a Convex tracker URL, for example `convex+http://127.0.0.1:3210`.",
		handshake: handshakeRequired,
	})
	return ct, orgID, err
}

func filterExperiments(exps []tracker.ExperimentRef, name string) []tracker.ExperimentRef {
	if name == "" {
		return exps
	}
	var out []tracker.ExperimentRef
	for _, e := range exps {
		if e.Name == name {
			out = append(out, e)
		}
	}
	return out
}

// reimportExperiment pages through one experiment's runs in the backend's
// stable order and processes each. Per-run failures are recorded in stats and
// never abort the page loop.
func reimportExperiment(ctx context.Context, ct *tracker.ConvexHTTPTracker, exp tracker.ExperimentRef, f reimportFlags, stats *reimportStats) error {
	cursor := ""
	for {
		if err := ctx.Err(); err != nil {
			return nil // interruption is reported by the caller, not per experiment
		}
		page, err := ct.ListReimportRuns(ctx, exp.ID, cursor, reimportPageSize)
		if err != nil {
			return fmt.Errorf("list runs: %w", err)
		}
		for _, raw := range page.Page {
			var run reimport.Run
			if err := run.UnmarshalRow(raw); err != nil {
				cliui.Warning(os.Stderr, fmt.Sprintf("%s: undecodable run row: %v", exp.Name, err), "")
				stats.failed++
				continue
			}
			reimportOne(ctx, ct, exp, run, f, stats)
		}
		if page.IsDone {
			return nil
		}
		cursor = page.ContinueCursor
	}
}

// reimportOne recomputes one run and reports/applies its drift.
func reimportOne(ctx context.Context, ct *tracker.ConvexHTTPTracker, exp tracker.ExperimentRef, run reimport.Run, f reimportFlags, stats *reimportStats) {
	if *f.run != "" && run.Name != *f.run {
		stats.skipped++
		return
	}
	if !run.Terminal() {
		stats.skipped++
		return
	}
	label := exp.Name + " / " + run.Name

	outText, source, err := reimportOutputText(ctx, ct, run)
	if err != nil {
		cliui.Warning(os.Stderr, fmt.Sprintf("%s: %v", label, err), "")
		stats.failed++
		return
	}
	if run.InputText == "" {
		// Without the input the run-type semantics (opt vs NEB vs plain) are
		// unknowable and a recomputed verdict would be a guess. Try the
		// original file, then give up on this run only.
		text, readErr := readLocalText(run.InputPath)
		if readErr != nil {
			cliui.Warning(os.Stderr, fmt.Sprintf("%s: no stored input text and the local input is unreadable: %v", label, readErr), "")
			stats.failed++
			return
		}
		run.InputText = text
	}

	fresh, err := reimport.Recompute(ctx, run, strings.NewReader(outText))
	if err != nil {
		cliui.Warning(os.Stderr, fmt.Sprintf("%s: %v", label, err), "")
		stats.failed++
		return
	}
	stats.scanned++

	changes := reimport.Diff(run.Fields, fresh)
	if len(changes) == 0 {
		stats.clean++
		return
	}
	stats.drifted++
	fmt.Fprintf(os.Stdout, "%-40s  [%s]  %s\n", label, source, reimport.Summary(changes))

	if !*f.fix {
		return
	}
	if err := ct.ApplyReimport(ctx, run.ID, reimport.Patch(changes), version.Version); err != nil {
		cliui.Warning(os.Stderr, fmt.Sprintf("%s: patch failed: %v", label, err), "")
		stats.failed++
		return
	}
	stats.fixed++
}

// reimportOutputText obtains the run's ORCA output text: the stored artifact
// when it is complete (so the sweep works without local files), otherwise the
// original file on disk. The returned source tag names which one fed the
// re-parse. Reading originals is fine; they are never opened for writing.
func reimportOutputText(ctx context.Context, ct *tracker.ConvexHTTPTracker, run reimport.Run) (string, string, error) {
	ref, err := ct.FindReimportOutput(ctx, run.ID)
	if err != nil {
		return "", "", fmt.Errorf("resolve stored output: %w", err)
	}
	var artifactErr error
	if ref != nil && !ref.Truncated {
		content, err := ct.GetArtifactContent(ctx, ref.ArtifactID)
		switch {
		case err != nil:
			artifactErr = err
		case content == nil:
			artifactErr = errors.New("artifact row vanished")
		case content.Truncated || content.Incomplete:
			artifactErr = errors.New("stored output is truncated")
		default:
			body, err := ct.FetchArtifactBody(ctx, content)
			if err != nil {
				artifactErr = err
			} else {
				return body, "artifact", nil
			}
		}
	} else if ref != nil {
		artifactErr = errors.New("stored output is truncated")
	}

	// Fall back to the original file on the machine running the sweep.
	for _, candidate := range localOutputCandidates(run, ref) {
		text, err := readLocalText(candidate)
		if err == nil {
			return text, "local file", nil
		}
	}
	if artifactErr != nil {
		return "", "", fmt.Errorf("no usable output: stored artifact unusable (%v) and no readable local file", artifactErr)
	}
	return "", "", errors.New("no usable output: no stored artifact and no readable local file")
}

// localOutputCandidates lists where the original .out might live, most
// specific first: the artifact's recorded absolute path, then the input path
// with its extension swapped, then that basename under the run's cwd.
func localOutputCandidates(run reimport.Run, ref *tracker.ReimportOutputRef) []string {
	var out []string
	if ref != nil && ref.Path != "" {
		out = append(out, ref.Path)
	}
	if run.InputPath != "" {
		stem := strings.TrimSuffix(run.InputPath, filepath.Ext(run.InputPath))
		out = append(out, stem+".out")
		if run.Cwd != "" {
			out = append(out, filepath.Join(run.Cwd, filepath.Base(stem)+".out"))
		}
	}
	return out
}

// readLocalText reads one candidate file, refusing empty paths early so the
// caller's loop stays simple.
func readLocalText(path string) (string, error) {
	if path == "" {
		return "", errors.New("no path recorded")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func printReimportSummary(stats *reimportStats, fix bool) {
	drift := fmt.Sprintf("%d drifted", stats.drifted)
	if fix {
		drift = fmt.Sprintf("%d drifted (%d fixed)", stats.drifted, stats.fixed)
	}
	fmt.Fprintf(os.Stderr, "\nDone: %d run(s) re-parsed — %d in sync, %s, %d skipped, %d failed.\n",
		stats.scanned, stats.clean, drift, stats.skipped, stats.failed)
	if !fix && stats.drifted > 0 {
		cliui.Hint(os.Stderr, "run `dftstream reimport --fix` to repair the drifted rows")
	}
}
