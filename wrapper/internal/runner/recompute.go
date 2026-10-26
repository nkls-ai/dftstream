package runner

import (
	"context"
	"errors"
	"io"
	"time"

	"github.com/nkls-ai/dftstream/internal/inputparse"
	"github.com/nkls-ai/dftstream/internal/parser"
	"github.com/nkls-ai/dftstream/internal/tracker"
)

// RecomputeStatus replays an already-captured ORCA output through the CURRENT
// parser and returns the terminal StatusUpdate the live pipeline would have
// produced for it. It is the engine of `dftstream reimport`: the derivation
// is the exact eventAccumulator + finalStatusUpdate path the live runner and
// the offline ingest use, folded over a no-op tracker, so a reimported verdict
// can never drift from what a fresh run of the same output would store.
//
// status and exitCode are the STORED execution facts of the run being
// re-parsed — reimport recomputes verdicts, it does not re-decide whether the
// process succeeded. The FinishedAt/Status/ExitCode fields of the returned
// update merely echo them and must not be written back.
//
// Read-only by construction: the output arrives as a reader and nothing here
// opens, writes, or stages any ORCA file.
func RecomputeStatus(
	ctx context.Context,
	summary inputparse.Summary,
	out io.Reader,
	status tracker.RunStatus,
	exitCode int,
) (tracker.StatusUpdate, error) {
	events := make(chan parser.Event, 1024)
	parseErrCh := make(chan error, 1)
	go func() {
		parseErrCh <- parser.New(nil).Parse(ctx, out, events)
		close(events)
	}()

	acc := newEventAccumulator(tracker.NewNoopTracker(), "", summary)
	var handleErrs []error
	for ev := range events {
		// The noop tracker cannot fail, but handle's contract returns errors;
		// collect rather than discard so that stays true if the sink changes.
		if err := acc.handle(ctx, ev); err != nil {
			handleErrs = append(handleErrs, err)
		}
	}
	if err := <-parseErrCh; err != nil {
		return tracker.StatusUpdate{}, err
	}
	if err := errors.Join(handleErrs...); err != nil {
		return tracker.StatusUpdate{}, err
	}
	return acc.finalStatusUpdate(status, exitCode, time.Now()), nil
}
