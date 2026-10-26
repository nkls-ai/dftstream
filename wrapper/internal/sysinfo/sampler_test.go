//go:build linux

package sysinfo

import (
	"context"
	"os/exec"
	"sync"
	"testing"
	"time"

	"github.com/nkls-ai/dftstream/internal/tracker"
)

type captureAppender struct {
	mu      sync.Mutex
	samples []tracker.SysSample
}

func (c *captureAppender) AppendSysSample(_ context.Context, _ tracker.RunID, s tracker.SysSample) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.samples = append(c.samples, s)
	return nil
}

func (c *captureAppender) all() []tracker.SysSample {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]tracker.SysSample(nil), c.samples...)
}

// TestSamplerAggregatesDescendants reproduces the ORCA process shape: an idle
// parent shell whose *grandchild* burns CPU. Sampling only the root would
// report ~0% — the aggregate must attribute the grandchild's work to the run.
func TestSamplerAggregatesDescendants(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// sh (idle) -> sh (idle) -> busy loop
	cmd := exec.CommandContext(ctx, "sh", "-c", `sh -c 'while :; do :; done' & wait`)
	if err := cmd.Start(); err != nil {
		t.Fatalf("start process tree: %v", err)
	}
	defer func() {
		cancel()
		_ = cmd.Wait() //nolint:errcheck — killed via context cancel, error is expected
	}()

	cap := &captureAppender{}
	s := &Sampler{
		Pid:      cmd.Process.Pid,
		Interval: 200 * time.Millisecond,
		Tracker:  cap,
		RunID:    "test-run",
	}
	samplerCtx, samplerCancel := context.WithTimeout(ctx, 3*time.Second)
	defer samplerCancel()
	done := make(chan struct{})
	go func() {
		s.Run(samplerCtx)
		close(done)
	}()

	deadline := time.After(3 * time.Second)
	for {
		var peak float64
		for _, smp := range cap.all() {
			if smp.CPUPct > peak {
				peak = smp.CPUPct
			}
		}
		// The busy grandchild should push the aggregate well past the ~0%
		// a root-only sampler reports. 20% keeps the test robust on a
		// heavily loaded machine.
		if peak > 20 {
			samplerCancel()
			<-done
			return
		}
		select {
		case <-deadline:
			t.Fatalf("aggregate CPU never exceeded 20%%; peak %.2f over %d samples — sampler is not seeing descendants", peak, len(cap.all()))
		case <-time.After(100 * time.Millisecond):
		}
	}
}
