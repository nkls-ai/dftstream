package tracker

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"
)

const (
	batchFlushInterval = 200 * time.Millisecond
	batchMaxSize       = 64
	batchFlushTimeout  = 10 * time.Second
	channelBuffer      = 4096
)

// BatchingTracker wraps any Tracker and coalesces append-style calls
// (events, metrics, sys samples, logs). All other operations — critical
// ones like CreateRun/UpdateRunStatus and the set-style writes — pass
// straight through to the embedded Tracker.
//
// If the underlying Tracker implements BulkAppender, BatchingTracker calls
// its bulk methods; otherwise it falls back to one-at-a-time.
type BatchingTracker struct {
	Tracker                // pass-through for every non-batched operation
	sink      BulkAppender // non-nil when the inner Tracker supports bulk writes
	queue     chan batchOp
	wg        sync.WaitGroup
	closeOnce sync.Once
	closeCh   chan struct{}
	closed    chan struct{}
	stateMu   sync.Mutex
	closing   bool
	errMu     sync.Mutex
	firstErr  error
}

type batchOpKind int

const (
	opEvent batchOpKind = iota
	opMetric
	opSys
	opLog
)

type batchOp struct {
	kind     batchOpKind
	runID    RunID
	event    Event
	metric   Metric
	sample   SysSample
	logEntry LogEntry
}

// WrapBatching returns a BatchingTracker around inner. If inner is
// already batching, it is returned unchanged.
func WrapBatching(inner Tracker) *BatchingTracker {
	if bt, ok := inner.(*BatchingTracker); ok {
		return bt
	}
	bt := &BatchingTracker{
		Tracker: inner,
		queue:   make(chan batchOp, channelBuffer),
		closeCh: make(chan struct{}),
		closed:  make(chan struct{}),
	}
	if s, ok := inner.(BulkAppender); ok {
		bt.sink = s
	}
	bt.wg.Add(1)
	go bt.loop()
	return bt
}

// runBuffer accumulates one op kind per run and flushes batches through
// flushFn. Owned exclusively by the loop goroutine — no locking.
type runBuffer[T any] struct {
	byRun   map[RunID][]T
	flushFn func(ctx context.Context, runID RunID, batch []T) error
}

func newRunBuffer[T any](flush func(context.Context, RunID, []T) error) *runBuffer[T] {
	return &runBuffer[T]{byRun: map[RunID][]T{}, flushFn: flush}
}

func (rb *runBuffer[T]) add(runID RunID, item T) {
	rb.byRun[runID] = append(rb.byRun[runID], item)
}

// flushAll flushes every run's batch under the shared ctx, reporting
// failures through record, then empties the buffer.
func (rb *runBuffer[T]) flushAll(ctx context.Context, record func(error)) {
	for runID, batch := range rb.byRun {
		if err := rb.flushFn(ctx, runID, batch); err != nil {
			record(err)
		}
	}
	clear(rb.byRun)
}

// flushRunIfFull flushes one run's batch under its own timeout once it
// reaches batchMaxSize, so a single chatty run is bounded between ticks.
func (rb *runBuffer[T]) flushRunIfFull(runID RunID, record func(error)) {
	if len(rb.byRun[runID]) < batchMaxSize {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), batchFlushTimeout)
	if err := rb.flushFn(ctx, runID, rb.byRun[runID]); err != nil {
		record(err)
	}
	cancel()
	delete(rb.byRun, runID)
}

func (b *BatchingTracker) loop() {
	defer b.wg.Done()
	defer close(b.closed)

	events := newRunBuffer(b.flushEvents)
	metrics := newRunBuffer(b.flushMetrics)
	samples := newRunBuffer(b.flushSysSamples)
	logs := newRunBuffer(b.flushLogs)

	// dispatch routes an op into the buffer for its kind.
	dispatch := func(op batchOp) {
		switch op.kind {
		case opEvent:
			events.add(op.runID, op.event)
		case opMetric:
			metrics.add(op.runID, op.metric)
		case opSys:
			samples.add(op.runID, op.sample)
		case opLog:
			logs.add(op.runID, op.logEntry)
		}
	}

	// flushAll drains all buffers in a fixed order (events, metrics,
	// samples, logs) under one shared timeout budget.
	flushAll := func() {
		ctx, cancel := context.WithTimeout(context.Background(), batchFlushTimeout)
		defer cancel()
		events.flushAll(ctx, b.recordErr)
		metrics.flushAll(ctx, b.recordErr)
		samples.flushAll(ctx, b.recordErr)
		logs.flushAll(ctx, b.recordErr)
	}

	flushIfFull := func(runID RunID) {
		events.flushRunIfFull(runID, b.recordErr)
		metrics.flushRunIfFull(runID, b.recordErr)
		samples.flushRunIfFull(runID, b.recordErr)
		logs.flushRunIfFull(runID, b.recordErr)
	}

	ticker := time.NewTicker(batchFlushInterval)
	defer ticker.Stop()

	for {
		select {
		case op := <-b.queue:
			dispatch(op)
			flushIfFull(op.runID)
		case <-ticker.C:
			flushAll()
		case <-b.closeCh:
			// Drain remaining queue.
			for {
				select {
				case op := <-b.queue:
					dispatch(op)
				default:
					flushAll()
					return
				}
			}
		}
	}
}

// flushBatch pushes one run's batch, preferring the bulk path and
// falling back to per-item writes, wrapping any failure with the batch
// size and run for diagnosis. noun is the human label used in that
// message (e.g. "event(s)").
func flushBatch[T any](
	ctx context.Context,
	runID RunID,
	batch []T,
	bulk func(context.Context, RunID, []T) error,
	perItem func(context.Context, RunID, T) error,
	noun string,
) error {
	if len(batch) == 0 {
		return nil
	}
	var err error
	if bulk != nil {
		err = bulk(ctx, runID, batch)
	} else {
		for _, item := range batch {
			if err = perItem(ctx, runID, item); err != nil {
				break
			}
		}
	}
	if err != nil {
		return fmt.Errorf("flush %d %s for run %s: %w", len(batch), noun, runID, err)
	}
	return nil
}

func (b *BatchingTracker) flushEvents(ctx context.Context, runID RunID, batch []Event) error {
	var bulk func(context.Context, RunID, []Event) error
	if b.sink != nil {
		bulk = b.sink.AppendEvents
	}
	return flushBatch(ctx, runID, batch, bulk, b.Tracker.AppendEvent, "event(s)")
}

func (b *BatchingTracker) flushMetrics(ctx context.Context, runID RunID, batch []Metric) error {
	var bulk func(context.Context, RunID, []Metric) error
	if b.sink != nil {
		bulk = b.sink.AppendMetrics
	}
	return flushBatch(ctx, runID, batch, bulk, b.Tracker.AppendMetric, "metric(s)")
}

func (b *BatchingTracker) flushSysSamples(ctx context.Context, runID RunID, batch []SysSample) error {
	var bulk func(context.Context, RunID, []SysSample) error
	if b.sink != nil {
		bulk = b.sink.AppendSysSamples
	}
	return flushBatch(ctx, runID, batch, bulk, b.Tracker.AppendSysSample, "system sample(s)")
}

func (b *BatchingTracker) flushLogs(ctx context.Context, runID RunID, batch []LogEntry) error {
	// AppendLogs is already bulk-shaped on the plain Tracker interface.
	bulk := b.Tracker.AppendLogs
	if b.sink != nil {
		bulk = b.sink.AppendLogs
	}
	return flushBatch[LogEntry](ctx, runID, batch, bulk, nil, "log(s)")
}

// Batched operations. Everything not overridden here passes through to
// the embedded Tracker.

func (b *BatchingTracker) AppendEvent(ctx context.Context, runID RunID, e Event) error {
	return b.enqueueOp(batchOp{kind: opEvent, runID: runID, event: e},
		"event", fmt.Sprintf("event kind=%s seq=%d for run %s", e.Kind, e.Seq, runID))
}

func (b *BatchingTracker) AppendMetric(ctx context.Context, runID RunID, m Metric) error {
	return b.enqueueOp(batchOp{kind: opMetric, runID: runID, metric: m},
		"metric", fmt.Sprintf("metric key=%s for run %s", m.Key, runID))
}

func (b *BatchingTracker) AppendSysSample(ctx context.Context, runID RunID, s SysSample) error {
	return b.enqueueOp(batchOp{kind: opSys, runID: runID, sample: s},
		"system-sample", fmt.Sprintf("sample for run %s", runID))
}

func (b *BatchingTracker) AppendLogs(ctx context.Context, runID RunID, entries []LogEntry) error {
	for _, e := range entries {
		if err := b.enqueueOp(batchOp{kind: opLog, runID: runID, logEntry: e},
			"log", fmt.Sprintf("log for run %s", runID)); err != nil {
			return err
		}
	}
	return nil
}

func (b *BatchingTracker) Close(ctx context.Context) error {
	b.closeOnce.Do(func() {
		b.stateMu.Lock()
		b.closing = true
		b.stateMu.Unlock()
		close(b.closeCh)
	})
	select {
	case <-b.closed:
	case <-ctx.Done():
		// Drain didn't finish before the close deadline: the flush goroutine is
		// still mid-flight and whatever it holds is lost when the process
		// exits. Say so explicitly instead of returning a bare ctx error.
		return errors.Join(
			fmt.Errorf("batch drain timed out; trailing tracking data may be lost: %w", ctx.Err()),
			b.err(),
		)
	}
	b.wg.Wait()
	return errors.Join(b.err(), b.Tracker.Close(ctx))
}

// enqueueOp queues one batch op. When the tracker is closed the drop is
// reported to the caller only; when the queue is full it is additionally
// recorded as the tracker's first error, since data was lost mid-run.
func (b *BatchingTracker) enqueueOp(op batchOp, queueName, desc string) error {
	err := b.enqueue(op)
	if err == nil {
		return nil
	}
	if errors.Is(err, errBatchingTrackerClosed) {
		return fmt.Errorf("batching tracker is closed; dropped %s", desc)
	}
	queueErr := fmt.Errorf("%s queue is full; dropped %s", queueName, desc)
	b.recordErr(queueErr)
	return queueErr
}

func (b *BatchingTracker) enqueue(op batchOp) error {
	b.stateMu.Lock()
	defer b.stateMu.Unlock()
	if b.closing {
		return errBatchingTrackerClosed
	}
	select {
	case b.queue <- op:
		return nil
	default:
		return errBatchingTrackerQueueFull
	}
}

// BackendVersion forwards the startup handshake to the wrapped tracker.
// The embedded Tracker interface does not carry it (only real backends
// can answer), so batching would otherwise hide the capability from the
// CLI. A wrapped tracker that cannot answer yields ErrVersionUnsupported,
// which callers treat as "unknown, carry on".
func (b *BatchingTracker) BackendVersion(ctx context.Context) (BackendVersion, error) {
	vr, ok := b.Tracker.(VersionReporter)
	if !ok {
		return BackendVersion{}, ErrVersionUnsupported
	}
	return vr.BackendVersion(ctx)
}

func (b *BatchingTracker) recordErr(err error) {
	if err == nil {
		return
	}
	log.Printf("dftstream: tracking warning: %v", err)
	b.errMu.Lock()
	defer b.errMu.Unlock()
	if b.firstErr == nil {
		b.firstErr = err
	}
}

func (b *BatchingTracker) err() error {
	b.errMu.Lock()
	defer b.errMu.Unlock()
	return b.firstErr
}

var _ Tracker = (*BatchingTracker)(nil)

var (
	errBatchingTrackerClosed    = errors.New("batching tracker is closed")
	errBatchingTrackerQueueFull = errors.New("batching tracker queue is full")
)
