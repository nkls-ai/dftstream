package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/nkls-ai/dftstream/internal/cliui"
	"github.com/nkls-ai/dftstream/internal/levels"
	"github.com/nkls-ai/dftstream/internal/logging"
	"github.com/nkls-ai/dftstream/internal/runner"
	"github.com/nkls-ai/dftstream/internal/sysinfo"
	"github.com/nkls-ai/dftstream/internal/tracker"
	"github.com/nkls-ai/dftstream/internal/version"
)

// importFlags holds the raw flag values of `dftstream import-experiments`.
type importFlags struct {
	fs           *flag.FlagSet
	batchName    *string
	batchParams  *string
	artifactsArg *string
	logLevelArg  *string
	dryRun       *bool
	force        *bool
	backend      backendFlags
}

// importConfig is the resolved batch/artifact configuration shared by
// every imported run.
type importConfig struct {
	batchName     string
	batchParams   map[string]any
	artifactLevel levels.ArtifactLevel
}

// importOutcome is the per-run result of one import attempt.
type importOutcome int

const (
	importSucceeded importOutcome = iota
	importSkipped
	importFailed
)

// ImportCmd implements `dftstream import-experiments <root>`.
//
// Layout the command expects:
//
//	<root>/
//	  <experiment-name>/
//	    <run-name-1>/
//	      *.inp
//	      *.out
//	      ...other orca files...
//	    <run-name-2>/
//	      ...
//
// For each leaf run-directory it locates a single .inp + matching .out
// pair, then drives runner.Ingest to populate the configured tracker.
// Runs without a .out are skipped with a warning (still in progress or
// crashed before output appeared). ORCA is never invoked.
func ImportCmd(args []string) int {
	f, err := parseImportFlags(args)
	if err != nil {
		return exitCodeFor(err)
	}
	root, err := validateImportRoot(f.fs)
	if err != nil {
		return exitCodeFor(err)
	}
	cfg, err := resolveImportConfig(f)
	if err != nil {
		return exitCodeFor(err)
	}
	jobs, err := planImport(root)
	if err != nil {
		return exitCodeFor(err)
	}
	if *f.dryRun {
		cliui.Hint(os.Stderr, "dry-run: nothing was uploaded")
		return 0
	}

	resolvedLogLevel := resolve(*f.logLevelArg, "DFTSTREAM_LOG_LEVEL", "")
	logLevel, err := logging.ParseLevel(resolvedLogLevel)
	if err != nil {
		cliui.Error(os.Stderr, err.Error(), "Pick one of: debug, info, warn (default), error.")
		return 2
	}

	orgID, tr, err := openAuthedTracker(f.backend.dsn(), f.backend.org,
		"Use `DFTSTREAM_TRACKER_URL=convex+http://127.0.0.1:3210` while Convex is running.")
	if err != nil {
		return exitCodeFor(err)
	}

	log := newImportLogger(logLevel, root, len(jobs), cfg.batchName)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	imported, skipped, failed := 0, 0, 0
	for _, j := range jobs {
		switch importOne(ctx, tr, log, orgID, cfg, j, *f.force) {
		case importSucceeded:
			imported++
		case importSkipped:
			skipped++
		case importFailed:
			failed++
		}
	}

	if err := flushImportTracker(tr); err != nil && failed == 0 {
		failed = 1
	}

	fmt.Fprintf(os.Stderr, "\nDone: %d imported, %d skipped, %d failed.\n", imported, skipped, failed)
	if failed > 0 {
		return 1
	}
	return 0
}

func parseImportFlags(args []string) (importFlags, error) {
	fs := flag.NewFlagSet("import-experiments", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)

	f := importFlags{
		fs:           fs,
		batchName:    fs.String("batch", "", "batch mode name; attaches imported runs to an experiment-level batch"),
		batchParams:  fs.String("batch-params", "", "comma-separated batch metadata as key=value pairs (also DFTSTREAM_BATCH_PARAMS)"),
		artifactsArg: fs.String("artifacts", "", "artifact level: none|io|essential|medium|all (default: env DFTSTREAM_ARTIFACTS or medium; batch default: io)"),
		logLevelArg:  fs.String("log-level", "", "logging verbosity: debug|info|warn|error|off (default: env DFTSTREAM_LOG_LEVEL or warn)"),
		dryRun:       fs.Bool("dry-run", false, "list what would be imported without writing to the tracker"),
		force:        fs.Bool("force", false, "re-import runs that already exist (default: skip duplicates)"),
	}
	f.backend.register(fs)
	showHelp := fs.Bool("help", false, "show help")

	fs.Usage = func() {
		cliui.Title(os.Stderr, "dftstream import-experiments")
		fmt.Fprintf(os.Stderr, `
Usage:
  dftstream import-experiments [flags] <root>

The <root> directory must contain one sub-directory per experiment, and
each experiment directory must contain one sub-directory per run with
the .inp and .out files in it:

  <root>/<experiment>/<run>/<stem>.inp
  <root>/<experiment>/<run>/<stem>.out

Flags:
`)
		fs.PrintDefaults()
	}

	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return importFlags{}, exitStatus(0)
		}
		return importFlags{}, exitStatus(2)
	}
	if *showHelp {
		fs.Usage()
		return importFlags{}, exitStatus(0)
	}
	return f, nil
}

// validateImportRoot checks the positional root argument and returns it
// as an absolute path.
func validateImportRoot(fs *flag.FlagSet) (string, error) {
	positional := fs.Args()
	if len(positional) < 1 {
		cliui.Error(os.Stderr, "missing root directory", "Pass the folder that contains <experiment>/<run>/ subdirectories.")
		fs.Usage()
		return "", exitStatus(2)
	}
	root, err := filepath.Abs(positional[0])
	if err != nil {
		cliui.Error(os.Stderr, fmt.Sprintf("could not resolve root path %q: %v", positional[0], err), "")
		return "", exitStatus(2)
	}
	fi, err := os.Stat(root)
	if err != nil || !fi.IsDir() {
		cliui.Error(os.Stderr, fmt.Sprintf("root is not a readable directory: %q", root), "")
		return "", exitStatus(2)
	}
	return root, nil
}

func resolveImportConfig(f importFlags) (importConfig, error) {
	resolvedBatch := resolve(*f.batchName, "DFTSTREAM_BATCH", "")
	artifactLevel, err := resolveArtifactLevel(*f.artifactsArg, resolvedBatch != "")
	if err != nil {
		return importConfig{}, err
	}
	batchMeta, err := parseBatchParams(resolve(*f.batchParams, "DFTSTREAM_BATCH_PARAMS", ""))
	if err != nil {
		cliui.Error(os.Stderr, err.Error(), "Use key=value pairs separated by commas, for example `--batch-params series=A,solvent=MeCN`.")
		return importConfig{}, exitStatus(2)
	}
	return importConfig{
		batchName:     resolvedBatch,
		batchParams:   batchMeta,
		artifactLevel: artifactLevel,
	}, nil
}

// planImport discovers the importable runs under root and prints the
// plan. Finding nothing is not an error — the command exits cleanly.
func planImport(root string) ([]importJob, error) {
	jobs, err := discoverImportJobs(root)
	if err != nil {
		cliui.Error(os.Stderr, fmt.Sprintf("scan root: %v", err), "")
		return nil, exitStatus(1)
	}
	if len(jobs) == 0 {
		cliui.Warning(os.Stderr, "no importable runs found", "Each run directory must contain a .inp and a .out file with matching stems.")
		return nil, exitStatus(0)
	}

	cliui.Title(os.Stderr, fmt.Sprintf("found %d run%s in %d experiment%s",
		len(jobs), plural(len(jobs)), countExperiments(jobs), plural(countExperiments(jobs))))
	for _, j := range jobs {
		fmt.Fprintf(os.Stderr, "  • %s / %s  (%s)\n", j.Experiment, j.Run, filepath.Base(j.OutputPath))
	}
	return jobs, nil
}

func newImportLogger(logLevel logging.Level, root string, jobCount int, batchName string) *logging.Logger {
	log := logging.New(logLevel)
	log.SystemInfo("dftstream import session", map[string]any{
		"version": version.Version,
		"root":    root,
		"jobs":    jobCount,
		"batch":   batchName,
	})
	log.SystemInfo("system environment", sysinfo.SystemMeta())
	return log
}

// importOne ingests a single discovered run, honoring the duplicate
// check unless force is set.
func importOne(ctx context.Context, tr tracker.Tracker, log *logging.Logger, orgID string, cfg importConfig, j importJob, force bool) importOutcome {
	fmt.Fprintf(os.Stderr, "\n→ importing %s / %s\n", j.Experiment, j.Run)
	log.Info("importing run", map[string]any{"experiment": j.Experiment, "run": j.Run})

	if !force {
		expID, err := tr.EnsureExperiment(ctx, orgID, j.Experiment)
		if err == nil {
			existing, findErr := tr.FindRunByName(ctx, expID, j.Run)
			if findErr != nil {
				cliui.Warning(os.Stderr, fmt.Sprintf("could not check for existing run %s / %s: %v", j.Experiment, j.Run, findErr), "")
				return importFailed
			}
			if existing != "" {
				cliui.Hint(os.Stderr, fmt.Sprintf("skipped %s / %s (already exists, use --force to re-import)", j.Experiment, j.Run))
				return importSkipped
			}
		}
	}

	res, err := runner.Ingest(ctx, runner.IngestOptions{
		RunDir:         j.RunDir,
		InputPath:      j.InputPath,
		OutputPath:     j.OutputPath,
		ExperimentName: j.Experiment,
		OrgID:          orgID,
		BatchName:      cfg.batchName,
		BatchParams:    cfg.batchParams,
		RunName:        j.Run,
		ArtifactLevel:  cfg.artifactLevel,
		Tracker:        tr,
		Logger:         log,
	})
	if err != nil || res.ExitCode != 0 {
		if err == nil {
			err = fmt.Errorf("imported output has nonzero status %d", res.ExitCode)
		}
		cliui.Warning(os.Stderr, fmt.Sprintf("import errors for %s / %s: %v", j.Experiment, j.Run, err), backendFixHint(err, ""))
		return importFailed
	}
	cliui.Success(os.Stderr, fmt.Sprintf("imported %s / %s", j.Experiment, j.Run))
	return importSucceeded
}

// flushImportTracker closes the tracker with a bounded timeout so
// batched writes land before the process exits.
func flushImportTracker(tr tracker.Tracker) error {
	closeCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := tr.Close(closeCtx); err != nil {
		cliui.Warning(os.Stderr, fmt.Sprintf("failed to flush tracker: %v", err), backendFixHint(err, ""))
		return err
	}
	return nil
}

// importJob is one (experiment, run) pair discovered on disk.
type importJob struct {
	Experiment string
	Run        string
	RunDir     string
	InputPath  string
	OutputPath string
}

// discoverImportJobs walks <root>/<exp>/<run>/ and returns one job per
// run directory that has a usable .inp/.out pair. Directories without a
// .out are silently skipped (run still in progress or no output yet).
func discoverImportJobs(root string) ([]importJob, error) {
	expEntries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	var out []importJob
	for _, ee := range expEntries {
		if !ee.IsDir() {
			continue
		}
		expDir := filepath.Join(root, ee.Name())
		runEntries, err := os.ReadDir(expDir)
		if err != nil {
			fmt.Fprintf(os.Stderr, "  warning: cannot read experiment dir %s: %v\n", ee.Name(), err)
			continue
		}
		for _, re := range runEntries {
			if !re.IsDir() {
				continue
			}
			runDir := filepath.Join(expDir, re.Name())
			inp, outp, ok := pickInpAndOut(runDir)
			if !ok {
				continue
			}
			out = append(out, importJob{
				Experiment: ee.Name(),
				Run:        re.Name(),
				RunDir:     runDir,
				InputPath:  inp,
				OutputPath: outp,
			})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Experiment != out[j].Experiment {
			return out[i].Experiment < out[j].Experiment
		}
		return out[i].Run < out[j].Run
	})
	return out, nil
}

// pickInpAndOut picks one .inp and a matching .out from runDir. If
// multiple candidates exist it prefers the pair with the same stem; as
// a last resort it returns the largest .out alongside any .inp.
func pickInpAndOut(runDir string) (string, string, bool) {
	entries, err := os.ReadDir(runDir)
	if err != nil {
		return "", "", false
	}
	var inps, outs []os.DirEntry
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := strings.ToLower(e.Name())
		if strings.HasSuffix(name, ".inp") {
			inps = append(inps, e)
		} else if strings.HasSuffix(name, ".out") &&
			!strings.HasSuffix(name, ".stdout.out") {
			outs = append(outs, e)
		}
	}
	if len(inps) == 0 || len(outs) == 0 {
		return "", "", false
	}
	// Try stem match first.
	for _, ie := range inps {
		stem := strings.TrimSuffix(ie.Name(), filepath.Ext(ie.Name()))
		for _, oe := range outs {
			oStem := strings.TrimSuffix(oe.Name(), filepath.Ext(oe.Name()))
			if oStem == stem {
				return filepath.Join(runDir, ie.Name()),
					filepath.Join(runDir, oe.Name()), true
			}
		}
	}
	// Fallback: first inp + first out lexicographically.
	sort.Slice(inps, func(i, j int) bool { return inps[i].Name() < inps[j].Name() })
	sort.Slice(outs, func(i, j int) bool { return outs[i].Name() < outs[j].Name() })
	return filepath.Join(runDir, inps[0].Name()),
		filepath.Join(runDir, outs[0].Name()), true
}

func countExperiments(jobs []importJob) int {
	seen := make(map[string]struct{}, len(jobs))
	for _, j := range jobs {
		seen[j.Experiment] = struct{}{}
	}
	return len(seen)
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}
