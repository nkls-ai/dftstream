package tracker

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"
)

// countingSink counts everything written through it and remembers the
// geometry frames, so a test can assert both the row budget and that the
// first/last structures survived decimation.
type countingSink struct {
	NoopTracker
	mu       sync.Mutex
	events   int
	metrics  int
	samples  int
	logs     int
	geomSeen []int // cycle numbers, in write order
}

func (c *countingSink) AppendEvent(context.Context, RunID, Event) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.events++
	return nil
}

func (c *countingSink) AppendMetric(context.Context, RunID, Metric) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.metrics++
	return nil
}

func (c *countingSink) AppendSysSample(context.Context, RunID, SysSample) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.samples++
	return nil
}

func (c *countingSink) AppendLogs(_ context.Context, _ RunID, entries []LogEntry) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.logs += len(entries)
	return nil
}

func (c *countingSink) AppendGeometry(_ context.Context, _ RunID, cycle int, _ string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.geomSeen = append(c.geomSeen, cycle)
	return nil
}

func (c *countingSink) total() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.events + c.metrics + c.samples + c.logs + len(c.geomSeen)
}

// throughputTestLimits mirrors the runner's ProfileThroughput budget. Kept
// local so this test proves the mechanism; runner_test proves the profile
// actually selects it.
var throughputTestLimits = SamplingLimits{
	MetricStride: 10, MaxMetricsPerKey: 200, MaxMetricsTotal: 1000,
	EventStride: 10, MaxEventsPerKind: 200, MaxEventsTotal: 1000,
	GeometryStride: 5, MaxGeometries: 50,
	MaxSysSamples: 240,
	MaxLogs:       500,
}

// metricKeys is the set of series a real run produces (scf iterations,
// gradients, ...). Held fixed so "rows per run" has a constant bound.
var metricKeys = []string{"scf_iter_energy", "scf_iter_deltaE", "opt_energy", "opt_gradMax", "opt_rmsdE"}

// driveSyntheticRun feeds tr the write pattern of an ORCA job that ran for
// `steps` iterations — the knob standing in for wallclock. Every producer
// in the wrapper is represented: parser events, metrics, geometry frames,
// resource samples and wrapper logs.
func driveSyntheticRun(t *testing.T, tr Tracker, steps int) {
	t.Helper()
	ctx := context.Background()
	const runID RunID = "run1"
	for i := 0; i < steps; i++ {
		ts := time.Unix(int64(i), 0)
		if err := tr.AppendEvent(ctx, runID, Event{Seq: int64(i), TS: ts, Kind: "scf_iter"}); err != nil {
			t.Fatalf("AppendEvent: %v", err)
		}
		for _, k := range metricKeys {
			if err := tr.AppendMetric(ctx, runID, Metric{Key: k, TS: ts, Value: float64(-76) - float64(i)*1e-6}); err != nil {
				t.Fatalf("AppendMetric: %v", err)
			}
		}
		if err := tr.AppendGeometry(ctx, runID, i, fmt.Sprintf("xyz-%d", i)); err != nil {
			t.Fatalf("AppendGeometry: %v", err)
		}
		if err := tr.AppendSysSample(ctx, runID, SysSample{TS: ts, CPUPct: 99}); err != nil {
			t.Fatalf("AppendSysSample: %v", err)
		}
		if err := tr.AppendLogs(ctx, runID, []LogEntry{{TS: ts, Level: "warn", Message: "noisy"}}); err != nil {
			t.Fatalf("AppendLogs: %v", err)
		}
	}
	if st, ok := tr.(*SamplingTracker); ok {
		if err := st.FlushDeferred(ctx); err != nil {
			t.Fatalf("FlushDeferred: %v", err)
		}
	}
}

// The contract of --profile throughput: rows written per run are bounded
// by a constant, not by wallclock. A run ten times longer must not write
// ten times the rows — it must write the same, bounded number, while the
// default profile records everything.
func TestThroughputProfileBoundsRowsIndependentlyOfRunLength(t *testing.T) {
	const short, long = 2_000, 20_000

	// Default profile: no limits at all — WrapSampling hands back the inner
	// tracker and every row lands.
	defShort, defLong := &countingSink{}, &countingSink{}
	driveSyntheticRun(t, WrapSampling(defShort, SamplingLimits{}), short)
	driveSyntheticRun(t, WrapSampling(defLong, SamplingLimits{}), long)

	rowsPerStep := 1 + len(metricKeys) + 3 // event + metrics + geometry + sample + log
	if got, want := defShort.total(), short*rowsPerStep; got != want {
		t.Fatalf("default profile wrote %d rows for %d steps, want %d (nothing may be dropped)", got, short, want)
	}
	if got, want := defLong.total(), long*rowsPerStep; got != want {
		t.Fatalf("default profile wrote %d rows for %d steps, want %d", got, long, want)
	}
	// Sanity: the default profile IS proportional to wallclock. That is the
	// problem the throughput profile solves.
	if defLong.total() <= defShort.total()*9 {
		t.Fatalf("default profile did not scale with run length: %d vs %d", defLong.total(), defShort.total())
	}

	// Throughput profile: same two runs, bounded rows.
	tpShort, tpLong := &countingSink{}, &countingSink{}
	driveSyntheticRun(t, WrapSampling(tpShort, throughputTestLimits), short)
	driveSyntheticRun(t, WrapSampling(tpLong, throughputTestLimits), long)

	bound := throughputTestLimits.MaxRowsPerRun(len(metricKeys))
	for name, sink := range map[string]*countingSink{"short": tpShort, "long": tpLong} {
		if sink.total() > bound {
			t.Errorf("throughput %s run wrote %d rows, exceeds the declared bound %d", name, sink.total(), bound)
		}
	}
	// The whole point: 10x the wallclock, the same row count.
	if tpShort.total() != tpLong.total() {
		t.Errorf("throughput rows depend on run length: %d (short) vs %d (long) — the bound must be a constant",
			tpShort.total(), tpLong.total())
	}
	// And it is a real reduction, not a rounding artifact.
	if tpLong.total()*20 > defLong.total() {
		t.Errorf("throughput wrote %d rows vs default %d — expected at least a 20x reduction",
			tpLong.total(), defLong.total())
	}
	t.Logf("rows per run: default(%d steps)=%d, throughput=%d (bound %d)",
		long, defLong.total(), tpLong.total(), bound)
}

// A decimated geometry series must still start on the input structure and
// end on the converged one — those are the two frames anyone looks at.
func TestThroughputKeepsFirstAndLastGeometry(t *testing.T) {
	sink := &countingSink{}
	const steps = 5_000
	driveSyntheticRun(t, WrapSampling(sink, throughputTestLimits), steps)

	if len(sink.geomSeen) == 0 {
		t.Fatal("no geometries written at all")
	}
	if sink.geomSeen[0] != 0 {
		t.Errorf("first geometry cycle = %d, want 0", sink.geomSeen[0])
	}
	if last := sink.geomSeen[len(sink.geomSeen)-1]; last != steps-1 {
		t.Errorf("last geometry cycle = %d, want %d (the final frame must survive decimation)", last, steps-1)
	}
	if len(sink.geomSeen) > throughputTestLimits.MaxGeometries+1 {
		t.Errorf("wrote %d geometries, cap is %d (+1 deferred final frame)",
			len(sink.geomSeen), throughputTestLimits.MaxGeometries)
	}
}

// Every metric series must end on its true final value, even though the
// stride dropped the rows around it — otherwise a chart's last point is a
// lie.
func TestThroughputFlushesFinalValueOfEachSeries(t *testing.T) {
	type lastValue struct {
		key   string
		value float64
	}
	var mu sync.Mutex
	var got []lastValue
	sink := &recordingLastMetric{fn: func(m Metric) {
		mu.Lock()
		defer mu.Unlock()
		got = append(got, lastValue{m.Key, m.Value})
	}}

	st := WrapSampling(sink, throughputTestLimits)
	ctx := context.Background()
	const steps = 3_000
	for i := 0; i < steps; i++ {
		for _, k := range metricKeys {
			if err := st.AppendMetric(ctx, "run1", Metric{Key: k, Value: float64(i)}); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := st.(*SamplingTracker).FlushDeferred(ctx); err != nil {
		t.Fatalf("FlushDeferred: %v", err)
	}

	final := map[string]float64{}
	for _, g := range got {
		final[g.key] = g.value
	}
	for _, k := range metricKeys {
		if final[k] != float64(steps-1) {
			t.Errorf("series %q ends at %v, want %v (final value must be preserved)", k, final[k], float64(steps-1))
		}
	}
}

type recordingLastMetric struct {
	NoopTracker
	fn func(Metric)
}

func (r *recordingLastMetric) AppendMetric(_ context.Context, _ RunID, m Metric) error {
	r.fn(m)
	return nil
}

// The zero SamplingLimits must be a true no-op: same tracker instance, no
// wrapper, no lock on the interactive path.
func TestWrapSamplingIsIdentityForZeroLimits(t *testing.T) {
	inner := &countingSink{}
	if got := WrapSampling(inner, SamplingLimits{}); got != Tracker(inner) {
		t.Fatalf("WrapSampling with zero limits returned %T, want the inner tracker unchanged", got)
	}
}

func TestSamplingGateStrideAndCap(t *testing.T) {
	g := &gate{stride: 3, max: 4}
	var admitted []int
	for i := 0; i < 100; i++ {
		if g.admit() {
			admitted = append(admitted, i)
		}
	}
	want := []int{0, 3, 6, 9}
	if len(admitted) != len(want) {
		t.Fatalf("admitted %v, want %v", admitted, want)
	}
	for i := range want {
		if admitted[i] != want[i] {
			t.Fatalf("admitted %v, want %v", admitted, want)
		}
	}
	if !g.capped() {
		t.Error("gate should report itself capped after reaching max")
	}
}
