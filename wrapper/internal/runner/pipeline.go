package runner

import (
	"context"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/nkls-ai/dftstream/internal/parser"
)

// eventPipeline tees ORCA stdout through the streaming parser and pumps
// each parsed event into the tracker accumulator and the .gbw
// snapshotter.
type eventPipeline struct {
	session *runSession
	acc     *eventAccumulator
	snap    *gbwSnapshotter

	pipeR    *io.PipeReader
	pipeW    *io.PipeWriter
	parseWG  sync.WaitGroup
	parseErr chan error
	pumpWG   sync.WaitGroup
}

func newEventPipeline(s *runSession, acc *eventAccumulator, snap *gbwSnapshotter) *eventPipeline {
	pr, pw := io.Pipe()
	return &eventPipeline{
		session:  s,
		acc:      acc,
		snap:     snap,
		pipeR:    pr,
		pipeW:    pw,
		parseErr: make(chan error, 1),
	}
}

// stdoutSink is the writer ORCA's stdout must be teed into for the
// parser to see it.
func (p *eventPipeline) stdoutSink() io.Writer { return p.pipeW }

func (p *eventPipeline) start(ctx context.Context) {
	events := make(chan parser.Event, 1024)
	p.parseWG.Add(1)
	go func() {
		defer p.parseWG.Done()
		p.parseErr <- parser.New(nil).Parse(ctx, p.pipeR, events)
		close(events)
	}()

	p.pumpWG.Add(1)
	go func() {
		defer p.pumpWG.Done()
		for ev := range events {
			// Bound each event's tracker write. Some event kinds bypass the
			// batching layer with synchronous retrying HTTP calls; without a
			// deadline an offline backend blocks this pump for the full retry
			// budget, the events channel fills, the parser stops draining the
			// stdout pipe, and ORCA itself stalls on write(). A bounded stall
			// keeps the calculation alive; the failure is still recorded.
			evCtx, evCancel := context.WithTimeout(ctx, 30*time.Second)
			if err := p.acc.handle(evCtx, ev); err != nil {
				p.session.errs.add(fmt.Errorf("track %s event: %w", ev.Kind(), err))
			}
			evCancel()
			p.snap.observe(ev)
		}
	}()
}

// drain closes the parser pipe (after ORCA has exited, or failed to
// start) and waits for the parser and pump goroutines to finish. Once it
// returns, no further tracker writes or snapshot launches can happen.
func (p *eventPipeline) drain(afterStartFailure bool) {
	closeMsg, parseMsg := "close parser pipe", "parse ORCA output"
	if afterStartFailure {
		closeMsg += " after ORCA start failure"
		parseMsg += " after start failure"
	}
	if err := p.pipeW.Close(); err != nil {
		p.session.errs.add(fmt.Errorf("%s: %w", closeMsg, err))
	}
	p.parseWG.Wait()
	if err := <-p.parseErr; err != nil {
		p.session.errs.add(fmt.Errorf("%s: %w", parseMsg, err))
	}
	p.pumpWG.Wait()
}
