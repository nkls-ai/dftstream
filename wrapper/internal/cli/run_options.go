package cli

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/nkls-ai/dftstream/internal/cliui"
	"github.com/nkls-ai/dftstream/internal/levels"
	"github.com/nkls-ai/dftstream/internal/logging"
	"github.com/nkls-ai/dftstream/internal/runner"
	"github.com/nkls-ai/dftstream/internal/stringutil"
)

// runOptions is the fully resolved and validated configuration for one
// `dftstream run` invocation.
type runOptions struct {
	inputPath     string
	orcaPath      string
	trackerURL    string
	orcaExtra     []string
	orgFlag       string
	expName       string
	runName       string
	batchName     string
	batchParams   map[string]any
	sysInterval   time.Duration
	artifactLevel levels.ArtifactLevel
	orbitalMode   levels.OrbitalMode
	logLevel      logging.Level
	lintEnabled   bool
	profile       runner.Profile
	offline       bool
}

// validateRunInput checks the positional input-file argument: it must be
// the only positional, readable, and end with the trailing newline ORCA
// requires. Returns the absolute path.
func validateRunInput(fs *flag.FlagSet) (string, error) {
	positional := fs.Args()
	if len(positional) < 1 {
		cliui.Error(os.Stderr, "missing input file", "Pass the ORCA input file, for example `dftstream run -orca /path/to/orca h2.inp`.")
		fs.Usage()
		return "", exitStatus(2)
	}
	inputPath, err := filepath.Abs(positional[0])
	if err != nil {
		cliui.Error(os.Stderr, fmt.Sprintf("could not resolve input path %q: %v", positional[0], err), "Check that the path is valid and try again.")
		return "", exitStatus(2)
	}
	if _, err := os.Stat(inputPath); err != nil {
		cliui.Error(os.Stderr, fmt.Sprintf("input file is not readable: %v", err), "Check the filename and file permissions.")
		return "", exitStatus(2)
	}
	if raw, err := os.ReadFile(inputPath); err == nil && len(raw) > 0 && raw[len(raw)-1] != '\n' {
		cliui.Error(os.Stderr,
			"input file does not end with a newline",
			"ORCA requires a trailing newline after the last line (typically the closing *).\n"+
				"Add an empty line at the end of "+filepath.Base(inputPath)+" and try again.\n"+
				"Quick fix: echo >> "+inputPath)
		return "", exitStatus(2)
	}
	// Any extra positionals before '--' are unexpected.
	if len(positional) > 1 {
		cliui.Error(os.Stderr, fmt.Sprintf("unexpected extra argument %q", positional[1]), "Use `--` before ORCA-specific arguments, for example `dftstream run -orca /path/to/orca h2.inp -- -some-orca-flag`.")
		return "", exitStatus(2)
	}
	return inputPath, nil
}

// resolveRunOptions layers flags over environment variables and
// defaults, validating each value. Each failure prints its own message.
func resolveRunOptions(f runFlags) (runOptions, error) {
	inputPath, err := validateRunInput(f.fs)
	if err != nil {
		return runOptions{}, err
	}

	resolvedOrca := resolve(*f.orcaPath, "DFTSTREAM_ORCA", "")
	if resolvedOrca == "" {
		cliui.Error(os.Stderr, "missing ORCA executable path", "Pass `-orca /path/to/orca` or set `DFTSTREAM_ORCA=/path/to/orca`.")
		return runOptions{}, exitStatus(2)
	}
	if _, err := os.Stat(resolvedOrca); err != nil {
		cliui.Error(os.Stderr, fmt.Sprintf("ORCA executable is not accessible at %q: %v", resolvedOrca, err), "Pass the correct executable with `-orca` or update `DFTSTREAM_ORCA`.")
		return runOptions{}, exitStatus(2)
	}
	resolvedTracker := f.backend.dsn()

	profile, err := runner.ParseProfile(resolve(*f.profileArg, "DFTSTREAM_PROFILE", ""))
	if err != nil {
		cliui.Error(os.Stderr, err.Error(), "Pick one of: default, throughput.")
		return runOptions{}, exitStatus(2)
	}
	throughput := profile == runner.ProfileThroughput

	resolvedBatch := resolve(*f.batchName, "DFTSTREAM_BATCH", "")
	// -batch already implies the lean artifact/orbital settings; the
	// throughput profile implies the same ones (and more below), so a batch
	// run and a throughput run agree rather than fight.
	lean := resolvedBatch != "" || throughput
	artifactLevel, err := resolveArtifactLevel(*f.artifactsArg, lean)
	if err != nil {
		return runOptions{}, err
	}
	orbitalMode, err := resolveOrbitalMode(*f.orbitalsArg, lean)
	if err != nil {
		return runOptions{}, err
	}

	resolvedLogLevel := resolve(*f.logLevelArg, "DFTSTREAM_LOG_LEVEL", "")
	logLevel, err := logging.ParseLevel(resolvedLogLevel)
	if err != nil {
		cliui.Error(os.Stderr, err.Error(), "Pick one of: debug, info, warn (default), error, off.")
		return runOptions{}, exitStatus(2)
	}
	// The throughput profile raises the log floor to warn: debug/info logging
	// is per-iteration chatter, and a thousand-job batch cannot afford it.
	// This is a floor, not a default — it overrides an explicit request, and
	// says so, because an unbounded row count is the thing the profile exists
	// to prevent.
	if throughput && logLevel < logging.LevelWarn {
		fmt.Fprintf(os.Stderr, "[dftstream] profile throughput: raising log level from %s to warn\n", logLevel.String())
		logLevel = logging.LevelWarn
	}

	sysInterval, err := resolveSysInterval(*f.sysInterval, throughput)
	if err != nil {
		cliui.Error(os.Stderr, err.Error(), "Use a duration such as `5s`/`1m`, or `off` to disable resource sampling.")
		return runOptions{}, exitStatus(2)
	}
	batchMeta, err := parseBatchParams(resolve(*f.batchParams, "DFTSTREAM_BATCH_PARAMS", ""))
	if err != nil {
		cliui.Error(os.Stderr, err.Error(), "Use key=value pairs separated by commas, for example `--batch-params conformer=7,solvent=MeCN`.")
		return runOptions{}, exitStatus(2)
	}

	resolvedLint := resolve(*f.lintArg, "DFTSTREAM_LINT", "on")
	lintEnabled, ok := stringutil.ParseBool(resolvedLint)
	if !ok {
		cliui.Error(os.Stderr, fmt.Sprintf("invalid -lint value %q", resolvedLint), "Pick one of: on (default), off.")
		return runOptions{}, exitStatus(2)
	}

	offline := *f.offlineArg || offlineFromEnv()

	expN := *f.expName
	if expN == "" {
		expN = runner.DefaultExperimentName(inputPath)
	}
	runN := *f.runName
	if runN == "" {
		runN = runner.DefaultRunName(inputPath)
	}

	return runOptions{
		inputPath:     inputPath,
		orcaPath:      resolvedOrca,
		trackerURL:    resolvedTracker,
		orcaExtra:     f.orcaExtra,
		orgFlag:       f.backend.org,
		expName:       expN,
		runName:       runN,
		batchName:     resolvedBatch,
		batchParams:   batchMeta,
		sysInterval:   sysInterval,
		artifactLevel: artifactLevel,
		orbitalMode:   orbitalMode,
		logLevel:      logLevel,
		lintEnabled:   lintEnabled,
		profile:       profile,
		offline:       offline,
	}, nil
}

// resolveArtifactLevel layers the -artifacts flag over DFTSTREAM_ARTIFACTS.
// Left unset, a lean run (batch, or the throughput profile) defaults to io;
// otherwise the parser's default (medium) applies.
func resolveArtifactLevel(flagVal string, lean bool) (levels.ArtifactLevel, error) {
	raw := resolve(flagVal, "DFTSTREAM_ARTIFACTS", "")
	if raw == "" && lean {
		return levels.ArtifactsIO, nil
	}
	l, err := levels.ParseArtifactLevel(raw)
	if err != nil {
		cliui.Error(os.Stderr, err.Error(), "Pick one of: none, io, essential, medium (default), all.")
		return 0, exitStatus(2)
	}
	return l, nil
}

// resolveOrbitalMode layers the -orbitals flag over DFTSTREAM_ORBITALS.
// Left unset, a lean run renders no orbitals; otherwise the parser's
// default (final) applies.
func resolveOrbitalMode(flagVal string, lean bool) (levels.OrbitalMode, error) {
	raw := resolve(flagVal, "DFTSTREAM_ORBITALS", "")
	if raw == "" && lean {
		return levels.OrbitalsNone, nil
	}
	m, err := levels.ParseOrbitalMode(raw)
	if err != nil {
		cliui.Error(os.Stderr, err.Error(), "Pick one of: none, final (default), per-cycle.")
		return "", exitStatus(2)
	}
	return m, nil
}

// resolveSysInterval turns the -sysinterval flag (or DFTSTREAM_SYSINTERVAL)
// into a sampling period. Unlike the other knobs it accepts `off`, which
// disables resource sampling entirely — a returned 0 that the runner
// honours literally. When unset, the throughput profile widens the default
// from 5s to 60s: enough to spot a node swapping, cheap enough that even a
// week-long job stays inside the profile's sample cap.
func resolveSysInterval(flagVal string, throughput bool) (time.Duration, error) {
	raw := resolve(flagVal, "DFTSTREAM_SYSINTERVAL", "")
	if raw == "" {
		if throughput {
			return runner.ThroughputSysInterval, nil
		}
		return defaultSysInterval, nil
	}
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "off", "none", "0":
		return 0, nil
	}
	d, err := time.ParseDuration(strings.TrimSpace(raw))
	if err != nil {
		return 0, fmt.Errorf("invalid -sysinterval value %q: %w", raw, err)
	}
	if d < 0 {
		return 0, fmt.Errorf("invalid -sysinterval value %q: must not be negative", raw)
	}
	return d, nil
}

// offlineFromEnv reports whether DFTSTREAM_OFFLINE asks for offline mode.
// Deliberately lenient: anything other than unset or a recognised false
// spelling means offline, because a typo must not make a firewalled
// compute node burn its walltime on connection timeouts.
func offlineFromEnv() bool {
	raw := strings.TrimSpace(os.Getenv("DFTSTREAM_OFFLINE"))
	if raw == "" {
		return false
	}
	v, ok := stringutil.ParseBool(raw)
	return !ok || v
}
