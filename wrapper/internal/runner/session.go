package runner

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/nkls-ai/dftstream/internal/artifacts"
	"github.com/nkls-ai/dftstream/internal/inputparse"
	"github.com/nkls-ai/dftstream/internal/levels"
	"github.com/nkls-ai/dftstream/internal/logging"
	"github.com/nkls-ai/dftstream/internal/sysinfo"
	"github.com/nkls-ai/dftstream/internal/tracker"
	"github.com/nkls-ai/dftstream/internal/version"
)

// runSession carries the state one ORCA invocation threads through its
// phases: registration with the tracker, process streaming, and
// finalization (status, postproc, artifacts, log flush).
type runSession struct {
	opts       Options
	log        *logging.Logger
	inputBytes []byte
	inputText  string
	cwd        string
	workDir    string
	stem       string
	summary    inputparse.Summary
	runID      tracker.RunID
	stdoutCap  *artifacts.CapWriter
	startedAt  time.Time
	errs       errorRecorder
	// sampler is non-nil only when a profile imposes row caps. It is the
	// tracker every producer writes through, and it holds back each
	// decimated series' final value until finalize flushes it.
	sampler *tracker.SamplingTracker
	// propertyJSON is the derived <stem>.property.json produced from the
	// run's .property.txt in a scratch dir (nil when ORCA wrote the JSON
	// itself, or when there was nothing to convert). Uploaded as an
	// artifact; never written into the chemist's directory.
	propertyJSON []byte
}

// newRunSession validates the options, applies defaults, and reads and
// parses the input file. No tracker calls happen yet.
func newRunSession(opts Options) (*runSession, error) {
	if opts.Tracker == nil {
		return nil, errors.New("runner: tracker is required")
	}
	if opts.Stdout == nil {
		opts.Stdout = os.Stdout
	}
	if opts.Stderr == nil {
		opts.Stderr = os.Stderr
	}
	log := opts.Logger
	if log == nil {
		log = logging.New(logging.LevelWarn)
	}

	log.SystemInfo("run starting", map[string]any{
		"inputPath":   opts.InputPath,
		"orcaPath":    opts.OrcaPath,
		"experiment":  opts.ExperimentName,
		"batch":       opts.BatchName,
		"runName":     opts.RunName,
		"artifacts":   opts.ArtifactLevel.String(),
		"orbitalMode": opts.OrbitalMode.String(),
	})

	inputBytes, err := os.ReadFile(opts.InputPath)
	if err != nil {
		log.Error("failed to read input file", map[string]any{"path": opts.InputPath, "error": err.Error()})
		return nil, fmt.Errorf("read input: %w", err)
	}
	inputText := string(inputBytes)

	cwd, err := os.Getwd()
	if err != nil {
		return nil, fmt.Errorf("get working directory: %w", err)
	}

	summary := inputparse.Parse(inputText)
	log.Debug("input parsed", map[string]any{
		"jobType": summary.JobType, "nprocs": summary.NProcs,
		"method": summary.Method, "basis": summary.Basis,
	})

	// Install the profile's row caps between the producers and the real
	// tracker, so every writer — parser pump, sysinfo sampler, log sink —
	// is bounded by the same budget no matter how long ORCA runs.
	var sampler *tracker.SamplingTracker
	if limits := opts.Profile.SamplingLimits(); !limits.IsZero() {
		wrapped := tracker.WrapSampling(opts.Tracker, limits)
		if st, ok := wrapped.(*tracker.SamplingTracker); ok {
			sampler = st
		}
		opts.Tracker = wrapped
		if opts.LogSink != nil {
			opts.LogSink.Tracker = wrapped
		}
		log.SystemInfo("throughput profile active — tracking rows are capped per run", map[string]any{
			"profile":       opts.Profile.String(),
			"maxRowsPerRun": limits.MaxRowsPerRun(0),
		})
	}

	return &runSession{
		opts:       opts,
		log:        log,
		sampler:    sampler,
		inputBytes: inputBytes,
		inputText:  inputText,
		cwd:        cwd,
		workDir:    filepath.Dir(opts.InputPath),
		stem:       DefaultRunName(opts.InputPath),
		summary:    summary,
		stdoutCap:  artifacts.NewCapWriter(artifacts.MaxTextContentBytes),
	}, nil
}

// register ensures the experiment/batch and creates the run row. If the
// tracker is unreachable, it swaps in a no-op tracker so ORCA still runs
// — the calculation must never fail because of a tracking problem.
func (s *runSession) register(ctx context.Context) {
	trackingOK := true
	expID, err := s.opts.Tracker.EnsureExperiment(ctx, s.opts.OrgID, s.opts.ExperimentName)
	if err != nil {
		s.log.Error("tracker unreachable — ORCA will run without tracking", map[string]any{"error": err.Error()})
		fmt.Fprintf(s.opts.Stderr, "[dftstream] WARNING: tracker unreachable (%v) — running ORCA without tracking\n", err)
		trackingOK = false
	}
	var batchID tracker.BatchID
	if trackingOK && s.opts.BatchName != "" {
		batchID, err = s.opts.Tracker.EnsureBatch(ctx, expID, s.opts.BatchName, s.opts.ArtifactLevel)
		if err != nil {
			s.log.Error("failed to create batch — ORCA will run without tracking", map[string]any{"error": err.Error()})
			fmt.Fprintf(s.opts.Stderr, "[dftstream] WARNING: create batch failed (%v) — running ORCA without tracking\n", err)
			trackingOK = false
		}
	}
	if trackingOK {
		parentID, parentEdge := resolveParentLink(ctx, s.opts.Tracker, expID, s.opts.ExperimentName, s.inputText, s.log)
		rc := newRunCreate(runRegistration{
			ExperimentID:   expID,
			BatchID:        batchID,
			BatchParams:    s.opts.BatchParams,
			Name:           s.opts.RunName,
			ParentRunID:    parentID,
			ParentEdgeKind: parentEdge,
			InputPath:      s.opts.InputPath,
			InputText:      s.inputText,
			CWD:            s.cwd,
		}, s.summary)
		rc.Hostname = sysinfo.Hostname()
		rc.NCores = sysinfo.NumCores()
		rc.SchedulerJobID = schedulerJobIDFromEnv()
		s.runID, err = s.opts.Tracker.CreateRun(ctx, rc)
		if err != nil {
			s.log.Error("failed to create run — ORCA will run without tracking", map[string]any{"error": err.Error()})
			fmt.Fprintf(s.opts.Stderr, "[dftstream] WARNING: create run failed (%v) — running ORCA without tracking\n", err)
			trackingOK = false
		}
	}
	if !trackingOK {
		s.opts.Tracker = tracker.NewNoopTracker()
		s.runID = "noop-run"
		if s.opts.LogSink != nil {
			s.opts.LogSink.Tracker = s.opts.Tracker
		}
		// The sampling wrapper points at a backend we just gave up on;
		// holding on to it would make finalize replay deferred rows into a
		// tracker nothing else writes to.
		s.sampler = nil
	}
	if s.opts.LogSink != nil {
		s.opts.LogSink.RunID = s.runID
	}
	if trackingOK {
		s.log.Info("run created", map[string]any{"runID": string(s.runID), "experimentID": string(expID)})
	}
}

// command builds the ORCA invocation. Run ORCA from the input file's
// directory, passing only the basename — exactly like a user typing
// `cd dir && orca x.inp`. ORCA bakes the working-directory path into the
// files it writes (notably the .gbw), so if we let it inherit
// dftstream's cwd (e.g. a /tmp scratch the user happened to launch
// from) those stray paths end up embedded in ORCA's own output,
// corrupting it relative to a normal run. Pinning cwd to the input dir
// also matches what snapshots, postproc, and artifact collection already
// assume about where ORCA writes.
func (s *runSession) command(ctx context.Context, parserSink io.Writer) *exec.Cmd {
	args := append([]string{filepath.Base(s.opts.InputPath)}, s.opts.OrcaExtraArgs...)
	cmd := exec.CommandContext(ctx, s.opts.OrcaPath, args...)
	cmd.Dir = s.workDir
	cmd.Stderr = s.opts.Stderr
	cmd.Stdout = io.MultiWriter(s.opts.Stdout, parserSink, s.stdoutCap)

	// ^C must reach the whole calculation, not just its launcher. See
	// proctree_unix.go: ORCA forks the orca_* MPI workers, and the default
	// cancel would kill only the driver — leaving the workers running on
	// the node and holding ORCA's stdout pipe open, which blocks cmd.Wait
	// indefinitely.
	configureCancellation(cmd)

	s.startedAt = time.Now()
	return cmd
}

// abortAfterStartFailure drains the pipeline, marks the run failed, and
// assembles the combined error for a cmd.Start() failure.
func (s *runSession) abortAfterStartFailure(startErr error, p *eventPipeline) (Result, error) {
	s.log.Error("ORCA failed to start", map[string]any{"error": startErr.Error()})
	p.drain(true)
	cleanupCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	statusErr := s.opts.Tracker.UpdateRunStatus(cleanupCtx, s.runID, tracker.StatusUpdate{
		Status: tracker.StatusFailed,
	})
	return Result{RunID: s.runID}, errors.Join(fmt.Errorf("start orca: %w", startErr), statusErr, s.errs.err())
}

func (s *runSession) markRunning(ctx context.Context, pid int) {
	s.log.Info("ORCA process started", map[string]any{"pid": pid})
	if err := s.opts.Tracker.UpdateRunStatus(ctx, s.runID, tracker.StatusUpdate{
		Status: tracker.StatusRunning,
	}); err != nil {
		s.errs.add(fmt.Errorf("mark run as running: %w", err))
	}
}

// startSysSampler samples cpu/mem/disk alongside ORCA. The returned stop
// function cancels the sampler and waits for it to exit.
// A non-positive interval (`-sysinterval off`) disables sampling
// altogether — the sampler's own zero-value handling would silently fall
// back to 5 s, which is the opposite of what the operator asked for.
func (s *runSession) startSysSampler(ctx context.Context, pid int) (stop func()) {
	if s.opts.SysInterval <= 0 {
		s.log.Debug("resource sampling disabled", nil)
		return func() {}
	}
	sysCtx, cancel := context.WithCancel(ctx)
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		(&sysinfo.Sampler{
			Pid:      pid,
			Interval: s.opts.SysInterval,
			Tracker:  s.opts.Tracker,
			RunID:    s.runID,
		}).Run(sysCtx)
	}()
	return func() {
		cancel()
		wg.Wait()
	}
}

// finalize records the final run status, then runs best-effort
// post-processing, uploads artifacts, and flushes logs.
func (s *runSession) finalize(waitErr error, acc *eventAccumulator, snap *gbwSnapshotter) (Result, error) {
	exitCode := exitCodeOf(waitErr)
	finStatus := tracker.StatusFinished
	if exitCode != 0 {
		finStatus = tracker.StatusFailed
	}
	cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cleanupCancel()
	upd := acc.finalStatusUpdate(finStatus, exitCode, time.Now())
	if err := s.opts.Tracker.UpdateRunStatus(cleanupCtx, s.runID, upd); err != nil {
		s.errs.add(fmt.Errorf("mark run final status: %w", err))
	}
	s.log.Info("ORCA process finished", map[string]any{
		"exitCode": exitCode, "status": string(finStatus),
	})

	// Replay the final value of every series the profile decimated. Done
	// before artifacts so a throughput-profile run still ends on the true
	// last energy and the true last geometry.
	if s.sampler != nil {
		if err := s.sampler.FlushDeferred(cleanupCtx); err != nil {
			s.errs.add(fmt.Errorf("flush deferred sampling tail: %w", err))
		}
	}

	// Reconcile ORCA's own machine-readable property file against what we
	// parsed out of stdout. Best-effort by construction: a missing or
	// unreadable property file is normal, and a disagreement is reported,
	// never "fixed" behind the chemist's back.
	s.ingestProperties(cleanupCtx, upd)

	s.reportTelemetry(cleanupCtx, upd, finStatus)

	// Best-effort post-processing: cubes for HOMO/LUMO via orca_plot,
	// displaced xyz frames for imaginary modes via orca_pltvib. Failures
	// are recorded but never block artifact upload.
	if finStatus == tracker.StatusFinished && s.opts.ArtifactLevel != levels.ArtifactsNone {
		// Postproc gets its own budget: the per-call timeouts inside (60s cubes
		// + 5m per-cycle cubes + 60s vib trjs + 120s intermediate hessians) sum
		// to ~9 minutes, and reusing the 60s cleanupCtx would silently truncate
		// them all to whatever remains of it.
		postprocCtx, postprocCancel := context.WithTimeout(context.Background(), 10*time.Minute)
		runPostproc(postprocCtx, s.opts, s.stdoutCap, snap.scratchDir(), snap.snapshotCycles())
		postprocCancel()
	}

	// Artifacts: stdout buffer + input + cwd files generated during the run.
	// Artifact upload gets its own timeout — large .out files need many
	// sequential chunk uploads and must not compete with postproc for time.
	artifactCtx, artifactCancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer artifactCancel()
	if err := uploadArtifacts(artifactCtx, s.opts.Tracker, s.runID, s.opts, s.inputBytes, s.stdoutCap, s.startedAt, s.derivedArtifacts()); err != nil {
		s.errs.add(fmt.Errorf("upload artifacts: %w", err))
	}
	if err := s.log.Flush(artifactCtx); err != nil {
		s.errs.add(fmt.Errorf("flush logs: %w", err))
	}

	var exitErr error
	if exitCode != 0 {
		exitErr = fmt.Errorf("orca exited with code %d", exitCode)
	}
	return Result{ExitCode: exitCode, RunID: s.runID}, errors.Join(exitErr, s.errs.err())
}

// runTypeStrings converts typed run types to the plain strings the
// tracker wire format stores.
func runTypeStrings(rts []inputparse.RunType) []string {
	if len(rts) == 0 {
		return nil
	}
	out := make([]string, len(rts))
	for i, t := range rts {
		out[i] = t.String()
	}
	return out
}

// runRegistration is what register() knows about a run before its row
// exists: where it sits (experiment, batch, workflow parent) and its input.
type runRegistration struct {
	ExperimentID   tracker.ExperimentID
	BatchID        tracker.BatchID
	BatchParams    map[string]any
	Name           string
	ParentRunID    tracker.RunID
	ParentEdgeKind string
	InputPath      string
	InputText      string
	CWD            string
}

// newRunCreate builds the runs:create payload shared by the live runner and
// the offline importer, so the two cannot drift. Host-specific fields
// (Hostname, NCores, SchedulerJobID) are left for the live caller to set:
// an import runs on a different machine than the calculation did.
func newRunCreate(reg runRegistration, summary inputparse.Summary) tracker.RunCreate {
	return tracker.RunCreate{
		ExperimentID:     reg.ExperimentID,
		ParentRunID:      reg.ParentRunID,
		ParentEdgeKind:   reg.ParentEdgeKind,
		BatchID:          reg.BatchID,
		BatchParams:      reg.BatchParams,
		Name:             reg.Name,
		NProcs:           summary.NProcs,
		MaxCoreMB:        summary.MaxCoreMB,
		JobType:          summary.JobType.String(),
		InputPath:        reg.InputPath,
		InputText:        reg.InputText,
		CWD:              reg.CWD,
		Keywords:         summary.Keywords,
		Functional:       summary.Functional,
		Basis:            summary.Basis,
		Method:           summary.Method,
		RunTypes:         runTypeStrings(summary.RunTypes),
		ScfTier:          summary.ScfTier,
		OptTier:          summary.OptTier,
		Grid:             summary.Grid,
		Solvent:          summary.Solvent,
		SolventModel:     summary.SolventModel,
		Corrections:      summary.Corrections,
		Charge:           summary.Charge,
		Mult:             summary.Mult,
		SubmittedBy:      resolveSubmittedBy(),
		DFTStreamVersion: version.Version,
	}
}
