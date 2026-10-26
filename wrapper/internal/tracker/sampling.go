package tracker

import (
	"context"
	"log"
	"sync"
	"time"
)

// SamplingLimits bounds how many rows ONE run may write, per category.
//
// The problem it solves: every high-frequency producer in the wrapper is
// driven by ORCA's output, so a 5-minute job and a 5-day job differ by
// three orders of magnitude in rows written. For an interactive run that
// fidelity is the point; for a 5000-job screening batch it is the
// difference between a responsive dashboard and a backend at its write
// quota. Under `--profile throughput` the limits below make rows-per-run
// a function of the limits alone — never of wallclock.
//
// Two knobs per category:
//
//	Stride  keep every Nth row of a series (1 = keep all)
//	Max     hard ceiling on rows actually written for that series
//
// Series are per key (metrics), per kind (events), or the single implicit
// series for geometries/samples/logs. A zero value in either field means
// "no limit for this category", and the zero SamplingLimits disables
// sampling entirely — which is exactly the default profile.
type SamplingLimits struct {
	// MetricStride/MaxMetricsPerKey decimate SCF and optimization metric
	// series (scf_iter_energy is by far the loudest producer).
	MetricStride     int
	MaxMetricsPerKey int
	// MaxMetricsTotal caps all metric series together, so a run that
	// somehow invents new keys cannot multiply its way past the budget.
	MaxMetricsTotal int

	// EventStride/MaxEventsPerKind decimate the raw event log. The
	// accumulator writes one event per SCF iteration alongside the metric.
	EventStride      int
	MaxEventsPerKind int
	MaxEventsTotal   int

	// GeometryStride/MaxGeometries keep first + every-k + last frames of a
	// geometry optimization. The last frame is what the UI shows, so it is
	// preserved out-of-band (see FlushDeferred) even when it lands on a
	// dropped stride slot.
	GeometryStride int
	MaxGeometries  int

	// MaxSysSamples caps the resource trace. With --profile throughput's
	// 60 s interval this is also a wallclock ceiling on the trace itself.
	MaxSysSamples int

	// MaxLogs caps wrapper log rows (already thinned by the warn level the
	// throughput profile forces, but an ORCA that warns in a loop must not
	// be able to outgrow the budget).
	MaxLogs int
}

// IsZero reports whether the limits impose nothing at all, in which case
// WrapSampling returns the inner tracker untouched.
func (l SamplingLimits) IsZero() bool { return l == SamplingLimits{} }

// MaxRowsPerRun is the arithmetic upper bound on rows a single run can
// write through a SamplingTracker with these limits — the number the
// `--profile throughput` contract is stated in. deferred is the number of
// held-back "last value" rows FlushDeferred may emit, which is bounded by
// the number of distinct metric keys plus the one geometry frame.
func (l SamplingLimits) MaxRowsPerRun(distinctMetricKeys int) int {
	return l.MaxMetricsTotal + l.MaxEventsTotal + l.MaxGeometries +
		l.MaxSysSamples + l.MaxLogs +
		distinctMetricKeys + 1 // deferred last values + last geometry
}

// gate implements "keep every Stride-th row, at most Max rows" for one
// series. Not safe for concurrent use on its own; SamplingTracker owns
// the lock.
type gate struct {
	seen    int
	written int
	stride  int
	max     int
}

// admit records one candidate row and reports whether it should be
// written. The first row of a series is always admitted (it is the
// baseline every chart needs); after that the stride applies, and the max
// stops the series dead.
func (g *gate) admit() bool {
	g.seen++
	if g.max > 0 && g.written >= g.max {
		return false
	}
	if g.stride > 1 && (g.seen-1)%g.stride != 0 {
		return false
	}
	g.written++
	return true
}

// capped reports whether this gate has hit its hard ceiling.
func (g *gate) capped() bool { return g.max > 0 && g.written >= g.max }

// SamplingTracker decimates high-frequency writes before they reach the
// wrapped Tracker, so a long run cannot outgrow a fixed row budget.
//
// It sits INSIDE the runner (between the producers and the batching
// tracker) rather than in the CLI, because the caps must hold regardless
// of which producer is chatty: the parser pump, the sysinfo sampler and
// the log sink all funnel through the same instance.
//
// Everything not decimated — run creation, status updates, frequencies,
// artifacts — passes straight through: those are O(1) per run already,
// and they are the rows a chemist actually needs.
type SamplingTracker struct {
	Tracker
	limits SamplingLimits

	mu       sync.Mutex
	runID    RunID
	metrics  map[string]*gate
	events   map[string]*gate
	geom     gate
	sys      gate
	logs     gate
	metricsW int
	eventsW  int

	// Held-back final values. A decimated series whose last point is
	// dropped would show the wrong converged energy / final structure, so
	// the most recent dropped row per metric key (and the single most
	// recent dropped geometry) is replayed by FlushDeferred at run end.
	lastMetric map[string]Metric
	lastGeom   *deferredGeometry

	// noticed marks categories that have already reported hitting their
	// cap, so the notice itself is O(1) per run.
	noticed map[string]bool
}

type deferredGeometry struct {
	cycle int
	xyz   string
}

// WrapSampling returns a SamplingTracker enforcing limits around inner.
// Zero limits (the default profile) return inner unchanged so the common
// path pays nothing — not even a mutex.
func WrapSampling(inner Tracker, limits SamplingLimits) Tracker {
	if limits.IsZero() {
		return inner
	}
	return &SamplingTracker{
		Tracker:    inner,
		limits:     limits,
		metrics:    map[string]*gate{},
		events:     map[string]*gate{},
		geom:       gate{stride: limits.GeometryStride, max: limits.MaxGeometries},
		sys:        gate{max: limits.MaxSysSamples},
		logs:       gate{max: limits.MaxLogs},
		lastMetric: map[string]Metric{},
		noticed:    map[string]bool{},
	}
}

// seriesGate returns (creating on first use) the gate for one key of a
// per-series category. Caller holds mu.
func seriesGate(m map[string]*gate, key string, stride, max int) *gate {
	g, ok := m[key]
	if !ok {
		g = &gate{stride: stride, max: max}
		m[key] = g
	}
	return g
}

func (s *SamplingTracker) AppendMetric(ctx context.Context, runID RunID, m Metric) error {
	s.mu.Lock()
	s.noteRunLocked(runID)
	g := seriesGate(s.metrics, m.Key, s.limits.MetricStride, s.limits.MaxMetricsPerKey)
	// Check the global ceiling first so a series gate is not consumed by a
	// row the total budget has already rejected.
	overTotal := s.limits.MaxMetricsTotal > 0 && s.metricsW >= s.limits.MaxMetricsTotal
	admit := !overTotal && g.admit()
	if admit {
		s.metricsW++
		delete(s.lastMetric, m.Key)
	} else {
		s.lastMetric[m.Key] = m
	}
	notice := !admit && s.noteOnce("metrics")
	s.mu.Unlock()

	if notice {
		s.reportCap(ctx, runID, "metrics")
	}
	if !admit {
		return nil
	}
	return s.Tracker.AppendMetric(ctx, runID, m)
}

func (s *SamplingTracker) AppendEvent(ctx context.Context, runID RunID, e Event) error {
	s.mu.Lock()
	s.noteRunLocked(runID)
	g := seriesGate(s.events, e.Kind, s.limits.EventStride, s.limits.MaxEventsPerKind)
	overTotal := s.limits.MaxEventsTotal > 0 && s.eventsW >= s.limits.MaxEventsTotal
	admit := !overTotal && g.admit()
	if admit {
		s.eventsW++
	}
	notice := !admit && s.noteOnce("events")
	s.mu.Unlock()

	if notice {
		s.reportCap(ctx, runID, "events")
	}
	if !admit {
		return nil
	}
	return s.Tracker.AppendEvent(ctx, runID, e)
}

func (s *SamplingTracker) AppendGeometry(ctx context.Context, runID RunID, cycle int, xyz string) error {
	s.mu.Lock()
	s.noteRunLocked(runID)
	admit := s.geom.admit()
	if admit {
		s.lastGeom = nil
	} else {
		s.lastGeom = &deferredGeometry{cycle: cycle, xyz: xyz}
	}
	notice := !admit && s.geom.capped() && s.noteOnce("geometries")
	s.mu.Unlock()

	if notice {
		s.reportCap(ctx, runID, "geometries")
	}
	if !admit {
		return nil
	}
	return s.Tracker.AppendGeometry(ctx, runID, cycle, xyz)
}

func (s *SamplingTracker) AppendSysSample(ctx context.Context, runID RunID, sample SysSample) error {
	s.mu.Lock()
	s.noteRunLocked(runID)
	admit := s.sys.admit()
	notice := !admit && s.noteOnce("sysSamples")
	s.mu.Unlock()

	if notice {
		s.reportCap(ctx, runID, "sysSamples")
	}
	if !admit {
		return nil
	}
	return s.Tracker.AppendSysSample(ctx, runID, sample)
}

func (s *SamplingTracker) AppendLogs(ctx context.Context, runID RunID, entries []LogEntry) error {
	kept := make([]LogEntry, 0, len(entries))
	s.mu.Lock()
	s.noteRunLocked(runID)
	for _, e := range entries {
		if s.logs.admit() {
			kept = append(kept, e)
		}
	}
	notice := len(kept) < len(entries) && s.noteOnce("logs")
	s.mu.Unlock()

	if notice {
		s.reportCap(ctx, runID, "logs")
	}
	if len(kept) == 0 {
		return nil
	}
	return s.Tracker.AppendLogs(ctx, runID, kept)
}

// FlushDeferred writes the held-back final values: the last dropped point
// of every decimated metric series and the last dropped geometry frame.
// Call it once, at run end, before Close. Bounded by the number of
// distinct metric keys plus one.
func (s *SamplingTracker) FlushDeferred(ctx context.Context) error {
	s.mu.Lock()
	pendingMetrics := make([]Metric, 0, len(s.lastMetric))
	for _, m := range s.lastMetric {
		pendingMetrics = append(pendingMetrics, m)
	}
	clear(s.lastMetric)
	geom := s.lastGeom
	s.lastGeom = nil
	runID := s.runID
	s.mu.Unlock()

	if runID == "" {
		// Nothing was ever written through this tracker, so there is no run
		// to attribute the tail to.
		return nil
	}
	var firstErr error
	record := func(err error) {
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}
	for _, m := range pendingMetrics {
		record(s.Tracker.AppendMetric(ctx, runID, m))
	}
	if geom != nil {
		record(s.Tracker.AppendGeometry(ctx, runID, geom.cycle, geom.xyz))
	}
	return firstErr
}

// noteOnce reports whether category has not yet announced that it hit its
// budget, marking it as announced. Caller holds mu.
func (s *SamplingTracker) noteOnce(category string) bool {
	if s.noticed[category] {
		return false
	}
	s.noticed[category] = true
	return true
}

// reportCap records, once per category, that decimation kicked in — so a
// chemist reading a sparse chart can tell it is the profile talking and
// not a broken parse. Written through the inner tracker so it bypasses
// the gates it is reporting on.
func (s *SamplingTracker) reportCap(ctx context.Context, runID RunID, category string) {
	err := s.Tracker.AppendEvent(ctx, runID, Event{
		TS:   time.Now(),
		Kind: "sampling_capped",
		Payload: map[string]any{
			"category": category,
			"profile":  "throughput",
			"note":     "rows decimated by the throughput profile; totals and final values are exact",
		},
	})
	if err != nil {
		// The notice is diagnostic garnish. Failing the producer's write
		// because the garnish did not land would be strictly worse — so it
		// is logged, not returned.
		log.Printf("dftstream: could not record %s sampling notice: %v", category, err)
	}
}

// noteRunLocked records the run every gated write belongs to, so
// FlushDeferred knows where to send the held-back tail without the caller
// threading the id back in. Caller holds mu.
func (s *SamplingTracker) noteRunLocked(runID RunID) {
	if s.runID == "" {
		s.runID = runID
	}
}

var _ Tracker = (*SamplingTracker)(nil)
