// Package cli implements the dftstream subcommands.
package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/nkls-ai/dftstream/internal/buildconfig"
	"github.com/nkls-ai/dftstream/internal/cliui"
	"github.com/nkls-ai/dftstream/internal/inputlint"
	"github.com/nkls-ai/dftstream/internal/logging"
	"github.com/nkls-ai/dftstream/internal/runner"
	"github.com/nkls-ai/dftstream/internal/spool"
	"github.com/nkls-ai/dftstream/internal/sysinfo"
	"github.com/nkls-ai/dftstream/internal/tracker"
	"github.com/nkls-ai/dftstream/internal/version"
)

const (
	defaultSysInterval = 5 * time.Second
)

// defaultTrackerURL is the fallback backend DSN when neither -tracker-url,
// DFTSTREAM_TRACKER_URL, nor a config-file URL is set. It derives from the
// build-time default Convex URL: a plain `go build` (dev) points at the local
// backend; release builds inject the production URL via ldflags. See
// internal/buildconfig.
var defaultTrackerURL = "convex+" + buildconfig.DefaultConvexURL

// runFlags holds the raw flag values of `dftstream run` plus the
// passthrough args after '--'. The FlagSet is kept so validation can
// reach the positionals and reprint usage.
type runFlags struct {
	fs           *flag.FlagSet
	orcaPath     *string
	expName      *string
	batchName    *string
	batchParams  *string
	runName      *string
	sysInterval  *string
	artifactsArg *string
	orbitalsArg  *string
	logLevelArg  *string
	lintArg      *string
	profileArg   *string
	offlineArg   *bool
	backend      backendFlags
	orcaExtra    []string
}

// RunCmd implements `dftstream run <input> [flags]`.
func RunCmd(args []string) int {
	f, err := parseRunFlags(args)
	if err != nil {
		return exitCodeFor(err)
	}
	opts, err := resolveRunOptions(f)
	if err != nil {
		return exitCodeFor(err)
	}
	orgID, tr, err := openRunTracker(opts)
	if err != nil {
		return exitCodeFor(err)
	}
	return executeRun(opts, orgID, tr)
}

func parseRunFlags(args []string) (runFlags, error) {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)

	f := runFlags{
		fs:           fs,
		orcaPath:     fs.String("orca", "", "path to orca binary (required unless DFTSTREAM_ORCA is set)"),
		expName:      fs.String("exp", "", "experiment name (default: parent dir of input file)"),
		batchName:    fs.String("batch", "", "batch mode name; attaches this run to an experiment-level batch"),
		batchParams:  fs.String("batch-params", "", "comma-separated batch metadata as key=value pairs (also DFTSTREAM_BATCH_PARAMS)"),
		runName:      fs.String("name", "", "run name (default: input filename without extension)"),
		sysInterval:  fs.String("sysinterval", "", "sysinfo sampling interval, or `off` to disable sampling (default: 5s; throughput profile: 60s)"),
		artifactsArg: fs.String("artifacts", "", "artifact level: none|io|essential|medium|all (default: env DFTSTREAM_ARTIFACTS or medium; batch default: io)"),
		orbitalsArg:  fs.String("orbitals", "", "orbital cube generation: none|final|per-cycle (default: env DFTSTREAM_ORBITALS or final)"),
		logLevelArg:  fs.String("log-level", "", "logging verbosity: debug|info|warn|error|off (default: env DFTSTREAM_LOG_LEVEL or warn)"),
		lintArg:      fs.String("lint", "", "input pre-flight checks before starting ORCA: on|off (default: env DFTSTREAM_LINT or on; advisory only, never blocks the run)"),
		profileArg:   fs.String("profile", "", "tracking profile: default|throughput (default: env DFTSTREAM_PROFILE or default; throughput caps rows written per run for large batches)"),
		offlineArg:   fs.Bool("offline", false, "skip the tracker entirely and journal all tracking data locally for a later `dftstream sync` (also DFTSTREAM_OFFLINE=1; for compute nodes with no outbound network)"),
	}
	f.backend.register(fs)
	showHelp := fs.Bool("help", false, "show help")

	fs.Usage = func() {
		cliui.Title(os.Stderr, "dftstream run")
		fmt.Fprintf(os.Stderr, `
Usage:
  dftstream run [flags] <inputfile> [-- <orca-args...>]

Flags:
`)
		fs.PrintDefaults()
		fmt.Fprintf(os.Stderr, `
Everything after '--' is forwarded to ORCA verbatim, after the input file.
`)
	}

	// Split args on the '--' separator before flag parsing so unknown
	// flags before '--' fail loudly.
	flagsArgs, extra := splitOnDoubleDash(args)
	// Reorder so all flags come first, then positionals. Lets users write
	// `dftstream run h2.inp --exp foo` as well as `--exp foo h2.inp`.
	flagsArgs = hoistFlags(fs, flagsArgs)
	if err := fs.Parse(flagsArgs); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return runFlags{}, exitStatus(0)
		}
		return runFlags{}, exitStatus(2)
	}
	if *showHelp {
		fs.Usage()
		return runFlags{}, exitStatus(0)
	}
	f.orcaExtra = extra
	return f, nil
}

// openRunTracker opens the tracker for one `dftstream run`:
//
//   - --offline / DFTSTREAM_OFFLINE=1 → no connection attempt at all; every
//     tracker op is journaled for a later `dftstream sync` (a SLURM job on a
//     firewalled compute node should not burn its walltime on timeouts);
//   - a Convex DSN → the live tracker wrapped in the spool failover, so a
//     backend that proves unreachable mid-command degrades to journaling
//     instead of dropping tracking. Auth errors and a definitive version
//     mismatch still surface loudly — they are fixable, an outage is not;
//   - any other DSN (noop://) → the plain tracker, unchanged.
func openRunTracker(opts runOptions) (string, tracker.Tracker, error) {
	orgID, src, err := resolveBackendAuth(opts.trackerURL, opts.orgFlag)
	if err != nil {
		return "", nil, err
	}
	spoolCfg := spool.WriterConfig{
		RunName:          opts.runName,
		ExperimentName:   opts.expName,
		Hostname:         sysinfo.Hostname(),
		DFTStreamVersion: version.Version,
	}
	if opts.offline {
		fo, err := spool.NewOffline(spoolCfg, os.Stderr)
		if err != nil {
			cliui.Error(os.Stderr, err.Error(), "Point DFTSTREAM_SPOOL_DIR at a writable directory.")
			return "", nil, exitStatus(2)
		}
		return orgID, tracker.WrapBatching(fo), nil
	}
	ct, err := tracker.OpenConvex(opts.trackerURL, src)
	if err != nil {
		// Not a Convex backend (noop://, or a bad DSN): use the plain factory,
		// which validates the DSN and needs no spool failover.
		tr, openErr := tracker.OpenWithAuth(opts.trackerURL, src)
		if openErr != nil {
			cliui.Error(os.Stderr, fmt.Sprintf("could not open tracker: %v", openErr),
				"Use `DFTSTREAM_TRACKER_URL=convex+http://127.0.0.1:3210` while Convex is running, or `noop://` for an offline smoke test.")
			return "", nil, exitStatus(2)
		}
		return orgID, tr, nil
	}
	// Handshake against the live backend before wrapping it: nothing has
	// been written yet, so a mismatch leaves no journal or flusher behind.
	if err := handshakeOrClose(ct, opts.trackerURL); err != nil {
		return "", nil, exitStatus(2)
	}
	if err := checkRunOrg(ct, orgID); err != nil {
		return "", nil, err
	}
	return orgID, tracker.WrapBatching(spool.NewFailover(ct, spoolCfg, os.Stderr)), nil
}

// checkRunOrg refuses to start ORCA when --org / DFTSTREAM_ORG names an
// organization the credential definitively cannot use. That used to surface
// only at the first write, where the runner treats every tracker error as
// "unreachable": the job ran untracked and still printed success. A lookup
// that merely failed in transit is left to the spool failover, as before.
func checkRunOrg(ct *tracker.ConvexHTTPTracker, orgRef string) error {
	if orgRef == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), orgCheckTimeout)
	defer cancel()
	_, err := ct.ResolveOrg(ctx, orgRef)
	if err == nil || !errors.Is(err, tracker.ErrOrgNotAvailable) {
		return nil
	}
	cliui.Error(os.Stderr, err.Error(), "Pass an organization this credential belongs to, or drop --org / DFTSTREAM_ORG. "+
		"A login or machine token acts in exactly one organization: `dftstream login` again for another, or mint a token in it.")
	if cerr := ct.Close(context.Background()); cerr != nil {
		// Nothing was written yet; closing loses no data. Still say so.
		fmt.Fprintf(os.Stderr, "[dftstream] note: closing tracker: %v\n", cerr) //nolint:errcheck — write to stderr is best-effort
	}
	return exitStatus(2)
}

// orgCheckTimeout bounds checkRunOrg's one lookup; past it the run proceeds
// and the spool failover owns the problem.
const orgCheckTimeout = 10 * time.Second

// executeRun drives the runner against the opened tracker and maps the
// outcome to the process exit code.
// preflightLint prints lint findings for the input before ORCA starts.
// Strictly advisory: it never blocks the run (the chemist may know
// better) and a panic inside the linter must never take the run down —
// but an impossible charge/multiplicity or an OOM-bound %maxcore is loud
// on stderr instead of surfacing hours later in the queue. Disable with
// `-lint off` or DFTSTREAM_LINT=off.
func preflightLint(inputPath string) {
	defer func() {
		if r := recover(); r != nil {
			// Advisory tooling must not break the calculation; note it
			// and move on.
			fmt.Fprintf(os.Stderr, "[dftstream] input pre-flight skipped (internal error: %v)\n", r)
		}
	}()
	text, err := os.ReadFile(inputPath)
	if err != nil {
		// The runner re-reads (and properly reports) the input itself.
		return
	}
	findings := inputlint.Lint(string(text), inputlint.Options{
		Dir:        filepath.Dir(inputPath),
		TotalRAMMB: sysinfo.TotalRAMMB(),
	})
	// Infos are noise at run time; only errors + warnings surface here.
	loud := findings[:0:0]
	for _, f := range findings {
		if f.Severity != inputlint.SeverityInfo {
			loud = append(loud, f)
		}
	}
	if len(loud) == 0 {
		return
	}
	cliui.Warning(os.Stderr, "input pre-flight found issues (run continues; disable with -lint off):", "")
	printLintFindings(loud)
}

func executeRun(opts runOptions, orgID string, tr tracker.Tracker) int {
	if opts.lintEnabled {
		preflightLint(opts.inputPath)
	}
	// Create logger with tracker sink — logs persist to DB for analysis.
	trackerSink := &logging.TrackerSink{Tracker: tr}
	log := logging.New(opts.logLevel, trackerSink)
	log.SystemInfo("dftstream session", map[string]any{
		"version":  version.Version,
		"logLevel": opts.logLevel.String(),
		"profile":  opts.profile.String(),
	})
	log.SystemInfo("system environment", sysinfo.SystemMeta())

	// Cancel on SIGINT/SIGTERM — propagate to ORCA so users can ^C.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	res, err := runner.Run(ctx, runner.Options{
		OrcaPath:       opts.orcaPath,
		InputPath:      opts.inputPath,
		OrcaExtraArgs:  opts.orcaExtra,
		ExperimentName: opts.expName,
		OrgID:          orgID,
		BatchName:      opts.batchName,
		BatchParams:    opts.batchParams,
		RunName:        opts.runName,
		SysInterval:    opts.sysInterval,
		ArtifactLevel:  opts.artifactLevel,
		OrbitalMode:    opts.orbitalMode,
		Profile:        opts.profile,
		Tracker:        tr,
		Logger:         log,
		LogSink:        trackerSink,
		Stdout:         os.Stdout,
		Stderr:         os.Stderr,
	})
	closeCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	closeErr := tr.Close(closeCtx)

	return reportRunOutcome(res, err, closeErr)
}

// reportRunOutcome prints run/flush errors and derives the exit code:
// ORCA's own exit code wins; tracking failures turn an otherwise clean
// run into exit 1.
func reportRunOutcome(res runner.Result, runErr, closeErr error) int {
	if runErr != nil || closeErr != nil {
		if runErr != nil {
			cliui.Error(os.Stderr, fmt.Sprintf("run completed with errors: %v", runErr), backendFixHint(runErr, "Check the ORCA output above and verify the tracker backend is reachable."))
		}
		if closeErr != nil {
			cliui.Error(os.Stderr, fmt.Sprintf("failed to flush tracking data: %v", closeErr), backendFixHint(closeErr, "Keep Convex running until the command exits; then rerun or inspect the run for missing events."))
		}
		if res.ExitCode == 0 {
			return 1
		}
	}
	if res.ExitCode == 0 {
		if spool.IsLocalID(string(res.RunID)) {
			cliui.Success(os.Stderr, "run journaled offline — upload it with `dftstream sync` from a host that reaches the backend")
		} else {
			cliui.Success(os.Stderr, fmt.Sprintf("tracked run %s", res.RunID))
		}
	}
	return res.ExitCode
}
