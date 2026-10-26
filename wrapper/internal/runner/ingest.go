package runner

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/nkls-ai/dftstream/internal/artifacts"
	"github.com/nkls-ai/dftstream/internal/inputparse"
	"github.com/nkls-ai/dftstream/internal/levels"
	"github.com/nkls-ai/dftstream/internal/logging"
	"github.com/nkls-ai/dftstream/internal/parser"
	"github.com/nkls-ai/dftstream/internal/tracker"
)

// IngestOptions configures a single offline-import of a finished ORCA
// run. Files are read from disk; ORCA is never executed.
type IngestOptions struct {
	// RunDir is the directory containing the run files. Artifact
	// collection roots here.
	RunDir string
	// InputPath is the absolute path to the .inp file.
	InputPath string
	// OutputPath is the absolute path to the .out file.
	OutputPath string
	// ExperimentName / RunName control how the run is stored.
	ExperimentName string
	// OrgID is the organization for the experiment ("" when auth off).
	OrgID       string
	BatchName   string
	BatchParams map[string]any
	RunName     string
	// ArtifactLevel selects how much of the run dir is uploaded.
	ArtifactLevel levels.ArtifactLevel
	// Tracker is the backend to write into.
	Tracker tracker.Tracker
	// Logger for structured diagnostics (optional).
	Logger *logging.Logger
}

// ingestSession carries the state one offline import threads through its
// phases: registration with the tracker, replaying the .out file through
// the parser, and finalization (status, artifacts).
type ingestSession struct {
	opts       IngestOptions
	log        *logging.Logger
	inputBytes []byte
	inputText  string
	summary    inputparse.Summary
	outFile    *os.File
	startedAt  time.Time
	runID      tracker.RunID
	errs       errorRecorder
}

// Ingest reads a finished ORCA .out file off disk, drives the same
// parser+tracker pipeline as a live run, and uploads artifacts. It
// never spawns ORCA. Status is derived from the parser's RunEndEvent.
// Each phase lives on ingestSession; Ingest only sequences them.
func Ingest(ctx context.Context, opts IngestOptions) (Result, error) {
	s, err := newIngestSession(opts)
	if err != nil {
		return Result{}, err
	}
	defer s.closeOutput()

	if err := s.register(ctx); err != nil {
		return Result{}, err
	}
	acc := s.replayOutput(ctx)
	return s.finalize(ctx, acc)
}

// newIngestSession validates the options, applies defaults, reads and
// parses the input file, and opens the .out file. No tracker calls
// happen yet.
func newIngestSession(opts IngestOptions) (*ingestSession, error) {
	if opts.Tracker == nil {
		return nil, errors.New("runner: tracker is required")
	}
	if opts.InputPath == "" || opts.OutputPath == "" {
		return nil, errors.New("runner: ingest requires InputPath and OutputPath")
	}
	log := opts.Logger
	if log == nil {
		log = logging.New(logging.LevelWarn)
	}
	log.Debug("ingest starting", map[string]any{
		"inputPath": opts.InputPath, "outputPath": opts.OutputPath,
	})

	inputBytes, err := os.ReadFile(opts.InputPath)
	if err != nil {
		return nil, fmt.Errorf("read input: %w", err)
	}
	inputText := string(inputBytes)
	summary := inputparse.Parse(inputText)

	outFile, err := os.Open(opts.OutputPath)
	if err != nil {
		return nil, fmt.Errorf("open output: %w", err)
	}

	// Use the .out file's mtime as a reasonable proxy for the run's
	// startedAt — this is the only timestamp we have offline.
	startedAt := time.Now()
	if fi, err := outFile.Stat(); err == nil {
		startedAt = fi.ModTime()
	}

	return &ingestSession{
		opts:       opts,
		log:        log,
		inputBytes: inputBytes,
		inputText:  inputText,
		summary:    summary,
		outFile:    outFile,
		startedAt:  startedAt,
	}, nil
}

func (s *ingestSession) closeOutput() {
	_ = s.outFile.Close() //nolint:errcheck — read-only handle; a close failure cannot lose data
}

// register ensures the experiment/batch and creates the run row. Unlike
// the live runner there is no calculation to protect, so tracker
// failures abort the import.
func (s *ingestSession) register(ctx context.Context) error {
	expID, err := s.opts.Tracker.EnsureExperiment(ctx, s.opts.OrgID, s.opts.ExperimentName)
	if err != nil {
		return fmt.Errorf("ensure experiment: %w", err)
	}
	var batchID tracker.BatchID
	if s.opts.BatchName != "" {
		batchID, err = s.opts.Tracker.EnsureBatch(ctx, expID, s.opts.BatchName, s.opts.ArtifactLevel)
		if err != nil {
			return fmt.Errorf("ensure batch: %w", err)
		}
	}
	parentID, parentEdge := resolveParentLink(ctx, s.opts.Tracker, expID, s.opts.ExperimentName, s.inputText, s.log)
	s.runID, err = s.opts.Tracker.CreateRun(ctx, newRunCreate(runRegistration{
		ExperimentID:   expID,
		BatchID:        batchID,
		BatchParams:    s.opts.BatchParams,
		Name:           s.opts.RunName,
		ParentRunID:    parentID,
		ParentEdgeKind: parentEdge,
		InputPath:      s.opts.InputPath,
		InputText:      s.inputText,
		CWD:            s.opts.RunDir,
	}, s.summary))
	if err != nil {
		return fmt.Errorf("create run: %w", err)
	}
	return nil
}

// replayOutput drives parser → tracker over the .out file. No need for
// goroutines / pipes here beyond the parser feed — we have the whole
// file on disk and can drain synchronously.
func (s *ingestSession) replayOutput(ctx context.Context) *eventAccumulator {
	events := make(chan parser.Event, 1024)
	parseErrCh := make(chan error, 1)
	go func() {
		parseErrCh <- parser.New(nil).Parse(ctx, s.outFile, events)
		close(events)
	}()

	acc := newEventAccumulator(s.opts.Tracker, s.runID, s.summary)
	for ev := range events {
		if err := acc.handle(ctx, ev); err != nil {
			s.errs.add(fmt.Errorf("track %s event: %w", ev.Kind(), err))
		}
	}
	if err := <-parseErrCh; err != nil {
		s.errs.add(fmt.Errorf("parse output: %w", err))
	}
	return acc
}

// finalize records the final run status (derived from whether ORCA's
// output terminated normally), uploads artifacts, and assembles the
// combined result.
func (s *ingestSession) finalize(ctx context.Context, acc *eventAccumulator) (Result, error) {
	runEndNormal := acc.runEndNormal.Load()
	finStatus := tracker.StatusFailed
	exitCode := 1
	if runEndNormal {
		finStatus = tracker.StatusFinished
		exitCode = 0
	}
	upd := acc.finalStatusUpdate(finStatus, exitCode, time.Now())
	if err := s.opts.Tracker.UpdateRunStatus(ctx, s.runID, upd); err != nil {
		s.errs.add(fmt.Errorf("mark run final status: %w", err))
	}

	if s.opts.ArtifactLevel != levels.ArtifactsNone {
		if err := s.opts.Tracker.SetArtifacts(ctx, s.runID, s.collectArtifacts()); err != nil {
			s.errs.add(fmt.Errorf("upload artifacts: %w", err))
		}
	}

	if !runEndNormal {
		s.log.Warn("ORCA output did not terminate normally", map[string]any{
			"inputPath": s.opts.InputPath,
		})
		s.errs.add(errors.New("ORCA output did not terminate normally"))
	} else {
		s.log.Info("ingest completed", map[string]any{
			"runID": string(s.runID), "status": string(finStatus),
		})
	}
	return Result{RunID: s.runID, ExitCode: exitCode}, s.errs.err()
}

// collectArtifacts assembles the artifact set for the import: the input
// file, the .out (playing the role of stdout), and the rest of the run
// dir at the configured level.
func (s *ingestSession) collectArtifacts() []tracker.Artifact {
	stem := DefaultRunName(s.opts.InputPath)
	inputName := filepath.Base(s.opts.InputPath)
	inputArt := artifacts.Artifact{
		Name:      inputName,
		Path:      s.opts.InputPath,
		Kind:      artifacts.KindInput,
		SizeBytes: int64(len(s.inputBytes)),
		MTime:     s.startedAt,
	}
	artifacts.AttachContent(&inputArt, s.inputBytes)
	items := []tracker.Artifact{inputArt}

	// The .out captured from disk plays the role of stdout. It is the
	// whole point of an import, so a read failure is worth a warning even
	// though the rest of the manifest still goes up.
	outBytes, err := artifacts.ReadCapped(s.opts.OutputPath)
	if err != nil {
		s.log.Warn("could not read the output file for upload", map[string]any{
			"path": s.opts.OutputPath, "error": err.Error(),
		})
	} else {
		// SizeBytes is the file on disk, not what we read, so an output
		// past the cap is recorded at its true size and flagged Truncated
		// by AttachContent rather than silently shrinking.
		size := int64(len(outBytes))
		if fi, statErr := os.Stat(s.opts.OutputPath); statErr == nil {
			size = fi.Size()
		} else {
			s.log.Warn("could not size the output file", map[string]any{
				"path": s.opts.OutputPath, "error": statErr.Error(),
			})
		}
		outArt := artifacts.Artifact{
			Name:      filepath.Base(s.opts.OutputPath),
			Path:      s.opts.OutputPath,
			Kind:      artifacts.KindOutput,
			SizeBytes: size,
			MTime:     s.startedAt,
		}
		artifacts.AttachContent(&outArt, outBytes)
		items = append(items, outArt)
	}

	// Collect returns everything it managed to build regardless of error,
	// so the loop runs either way; the error names the files it could not
	// read, which the operator needs to see rather than discover as an
	// empty artifact in the UI.
	cwdArts, err := artifacts.Collect(s.opts.RunDir, stem, time.Time{}, s.opts.ArtifactLevel)
	if err != nil {
		s.log.Warn("some artifacts could not be read", map[string]any{
			"error": err.Error(), "collected": len(cwdArts),
		})
	}
	for _, a := range cwdArts {
		// Skip input + the already-captured .out; we attached them
		// explicitly with the input/output kinds above.
		if a.Name == inputName || a.Path == s.opts.OutputPath {
			continue
		}
		items = append(items, a)
	}
	return items
}
