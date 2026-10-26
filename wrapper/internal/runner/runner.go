// Package runner orchestrates an ORCA child process: tee stdout, drive
// the parser, feed the tracker, sample sysinfo, manage run lifecycle.
package runner

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/nkls-ai/dftstream/internal/inputparse"
	"github.com/nkls-ai/dftstream/internal/levels"
	"github.com/nkls-ai/dftstream/internal/logging"
	"github.com/nkls-ai/dftstream/internal/tracker"
)

// Profile selects a coherent set of tracking defaults for a class of
// workload. It is a policy knob, not a feature switch: every individual
// setting a profile implies can still be overridden by its own flag.
type Profile string

const (
	// ProfileDefault is full-fidelity interactive tracking: every SCF
	// iteration, every geometry, 5 s resource samples. What a chemist
	// watching one job wants.
	ProfileDefault Profile = "default"
	// ProfileThroughput is for high-throughput batches (thousands of jobs
	// on a cluster), where the dashboard's job is to answer "which ones
	// failed / what are the energies", not to replay every iteration. It
	// caps rows written per run at a constant so the backend's write
	// budget scales with the number of jobs, not with their wallclock.
	ProfileThroughput Profile = "throughput"
)

func (p Profile) String() string { return string(p) }

// ParseProfile parses a profile name as used by the CLI/env. Empty string
// returns the default.
func ParseProfile(s string) (Profile, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "", "default", "interactive", "full":
		return ProfileDefault, nil
	case "throughput", "batch", "screen", "screening":
		return ProfileThroughput, nil
	default:
		return ProfileDefault, fmt.Errorf("unknown profile %q (use default|throughput)", s)
	}
}

// ThroughputSysInterval is the resource-sampling interval the throughput
// profile applies when the operator did not pick one. Twelve times the
// interactive default: enough to spot a node swapping, cheap enough that
// a week-long job still fits the sample cap.
const ThroughputSysInterval = 60 * time.Second

// throughputLimits is the row budget of ProfileThroughput.
//
// Sized so a run's tracking footprint is ~2.8k rows no matter whether it
// takes four minutes or four weeks, while keeping the shape of every
// series legible: the first point of each series is always kept, one in
// ten thereafter, and each series' final value is preserved exactly (see
// SamplingTracker.FlushDeferred). Totals, status, thermochemistry,
// frequencies and artifacts are untouched by any of this — they are O(1)
// per run and they are the numbers that get published.
var throughputLimits = tracker.SamplingLimits{
	MetricStride:     10,
	MaxMetricsPerKey: 200,
	MaxMetricsTotal:  1000,

	EventStride:      10,
	MaxEventsPerKind: 200,
	MaxEventsTotal:   1000,

	GeometryStride: 5,
	MaxGeometries:  50,

	MaxSysSamples: 240,
	MaxLogs:       500,
}

// SamplingLimits returns the per-run row budget this profile enforces.
// The default profile returns the zero value, i.e. no decimation at all —
// and WrapSampling then leaves the tracker untouched, so the interactive
// path pays nothing for this feature existing.
func (p Profile) SamplingLimits() tracker.SamplingLimits {
	if p == ProfileThroughput {
		return throughputLimits
	}
	return tracker.SamplingLimits{}
}

// Options is the runtime configuration for a single ORCA invocation.
type Options struct {
	OrcaPath       string   // absolute path to orca binary
	InputPath      string   // absolute path to orca input file
	OrcaExtraArgs  []string // forwarded to orca verbatim, after InputPath
	ExperimentName string
	OrgID          string // organization for the experiment ("" when auth off)
	BatchName      string
	BatchParams    map[string]any
	RunName        string
	// SysInterval is the resource-sampling period; <= 0 disables sampling
	// entirely (`-sysinterval off`).
	SysInterval   time.Duration
	ArtifactLevel levels.ArtifactLevel
	OrbitalMode   levels.OrbitalMode
	// Profile bounds how many rows this run may write. The zero value
	// ("") behaves as ProfileDefault: no decimation.
	Profile Profile
	Tracker tracker.Tracker
	Logger  *logging.Logger
	LogSink *logging.TrackerSink // receives the RunID once known
	Stdout  io.Writer            // passthrough sink (typically os.Stdout)
	Stderr  io.Writer            // passthrough sink (typically os.Stderr)
}

// Result of a Run.
type Result struct {
	ExitCode int
	RunID    tracker.RunID
}

// Run executes ORCA and returns when it has exited. The returned exit
// code should be propagated to the wrapper's own exit code. Each phase
// lives on runSession; Run only sequences them.
func Run(ctx context.Context, opts Options) (Result, error) {
	s, err := newRunSession(opts)
	if err != nil {
		return Result{}, err
	}
	s.register(ctx)

	snap := newGbwSnapshotter(s.opts, s.summary.JobType.IsGeometryOpt(), s.workDir, s.stem)
	defer snap.cleanup()

	acc := newEventAccumulator(s.opts.Tracker, s.runID, s.summary)
	pipeline := newEventPipeline(s, acc, snap)
	cmd := s.command(ctx, pipeline.stdoutSink())
	pipeline.start(ctx)

	s.log.Debug("starting ORCA process", map[string]any{"cmd": s.opts.OrcaPath, "args": cmd.Args[1:]})
	if err := cmd.Start(); err != nil {
		return s.abortAfterStartFailure(err, pipeline)
	}
	s.markRunning(ctx, cmd.Process.Pid)
	stopSampler := s.startSysSampler(ctx, cmd.Process.Pid)
	stopLiveSync := s.startLiveArtifactSync(ctx)

	waitErr := cmd.Wait()
	if ctx.Err() != nil {
		// The run was cancelled (^C / SIGTERM). Wait has already given the
		// tree orcaShutdownGrace to go quietly; anything still alive is
		// ignoring SIGTERM and would otherwise stay on the node forever.
		if err := reapProcessTree(cmd); err != nil {
			s.errs.add(fmt.Errorf("kill remaining ORCA processes after cancellation: %w", err))
		}
	}
	stopLiveSync()
	pipeline.drain(false)
	// The pump owns the launch of per-cycle snapshot goroutines, so once it
	// has drained no new copies can start. Wait for in-flight copies on EVERY
	// path (failed run, LevelNone, etc.) before the deferred snap.cleanup()
	// can fire — otherwise those goroutines race the recursive delete of the
	// dir they are copying into, leaking goroutines and corrupting scratch.
	snap.wait()
	stopSampler()

	return s.finalize(waitErr, acc, snap)
}

func exitCodeOf(waitErr error) int {
	if waitErr == nil {
		return 0
	}
	var ee *exec.ExitError
	if errors.As(waitErr, &ee) {
		return ee.ExitCode()
	}
	return -1
}

type errorRecorder struct {
	mu       sync.Mutex
	firstErr error
}

func (r *errorRecorder) add(err error) {
	if err == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.firstErr == nil {
		r.firstErr = err
		return
	}
	r.firstErr = errors.Join(r.firstErr, err)
}

func (r *errorRecorder) err() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.firstErr
}

// DefaultRunName returns a sensible run name derived from the input path.
// resolveParentLink resolves a generated input's provenance comment
// (`# dftstream: edge=... parent="exp/run"`) to a run id. Best-effort:
// only parents inside the same experiment resolve — a cross-experiment
// lookup would create the experiment as a side effect of EnsureExperiment,
// and lineage is never worth a tracker write. Returns zero values when
// there is nothing to link.
func resolveParentLink(ctx context.Context, tr tracker.Tracker, expID tracker.ExperimentID, expName, inputText string, log *logging.Logger) (tracker.RunID, string) {
	prov, ok := inputparse.ParseProvenance(inputText)
	if !ok {
		return "", ""
	}
	if prov.ParentExp != expName {
		log.Debug("provenance parent is in a different experiment — not linking", map[string]any{
			"parent": prov.ParentExp + "/" + prov.ParentRun, "experiment": expName,
		})
		return "", ""
	}
	id, err := tr.FindRunByName(ctx, expID, prov.ParentRun)
	if err != nil || id == "" {
		log.Debug("provenance parent not found — not linking", map[string]any{
			"parent": prov.ParentExp + "/" + prov.ParentRun,
		})
		return "", ""
	}
	return id, prov.Edge
}

func DefaultRunName(inputPath string) string {
	base := filepath.Base(inputPath)
	if i := strings.LastIndex(base, "."); i > 0 {
		base = base[:i]
	}
	return base
}

func resolveSubmittedBy() string {
	if u := os.Getenv("DFTSTREAM_USER"); u != "" {
		return u
	}
	return os.Getenv("USER")
}

func DefaultExperimentName(inputPath string) string {
	abs, err := filepath.Abs(inputPath)
	if err != nil {
		return "default"
	}
	parent := filepath.Base(filepath.Dir(abs))
	if parent == "" || parent == "." {
		return "default"
	}
	return parent
}
