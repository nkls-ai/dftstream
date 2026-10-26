// Package sysinfo samples runtime resource usage for the wrapped ORCA process.
package sysinfo

import (
	"context"
	"errors"
	"log"
	"os"
	"runtime"
	"time"

	"github.com/shirou/gopsutil/v3/mem"
	"github.com/shirou/gopsutil/v3/process"

	"github.com/nkls-ai/dftstream/internal/tracker"
)

// SystemMeta returns a map of system metadata for diagnostic logging.
// Always captured regardless of log level — needed for crash analysis.
func SystemMeta() map[string]any {
	m := map[string]any{
		"hostname": Hostname(),
		"ncores":   NumCores(),
		"os":       runtime.GOOS,
		"arch":     runtime.GOARCH,
		"goVer":    runtime.Version(),
		"pid":      os.Getpid(),
	}
	if wd, err := os.Getwd(); err == nil {
		m["cwd"] = wd
	}
	if u := os.Getenv("USER"); u != "" {
		m["user"] = u
	}
	return m
}

// Hostname returns os.Hostname or "" on error.
func Hostname() string {
	h, err := os.Hostname()
	if err != nil {
		return ""
	}
	return h
}

// NumCores returns the number of logical CPUs visible to the wrapper.
func NumCores() int { return runtime.NumCPU() }

// TotalRAMMB returns the machine's physical memory in MB, or 0 when it
// cannot be determined (callers treat 0 as "check unavailable").
func TotalRAMMB() int {
	vm, err := mem.VirtualMemory()
	if err != nil {
		return 0
	}
	return int(vm.Total / (1024 * 1024))
}

// errProcessGone signals that the sampled root process no longer exists —
// the normal end-of-run condition for the sampler loop.
var errProcessGone = errors.New("sampled process is gone")

// Sampler periodically samples the given process *and all its descendants*
// and emits aggregated SysSamples to the tracker until the root process exits
// or ctx is canceled. Aggregation over the whole tree matters: the ORCA
// driver binary only dispatches worker processes (orca_scf, mpirun, ...) and
// idles itself, so sampling the root alone reports near-zero CPU and a small
// constant RSS. It only needs the sample-append capability, not the full
// Tracker.
type Sampler struct {
	Pid      int
	Interval time.Duration
	Tracker  tracker.SysSampleAppender
	RunID    tracker.RunID

	// handles caches one process handle per live pid across ticks: gopsutil's
	// PercentWithContext(ctx, 0) diffs against the state stored on the handle,
	// so a fresh handle would always report 0.
	handles map[int32]*process.Process
}

// Run blocks until ctx is canceled or the root process disappears.
func (s *Sampler) Run(ctx context.Context) {
	if s.Interval <= 0 {
		s.Interval = 5 * time.Second
	}
	s.handles = make(map[int32]*process.Process)

	// Prime CPU baselines: the first Percent call on each handle returns 0
	// (nothing to diff against), so take one throwaway, unrecorded sample
	// before the ticker starts.
	if !s.sampleOnce(ctx, false) {
		return
	}

	t := time.NewTicker(s.Interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			finalCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			s.sampleOnce(finalCtx, true) // final sample
			cancel()
			return
		case <-t.C:
			if !s.sampleOnce(ctx, true) {
				return
			}
		}
	}
}

// sampleOnce aggregates cpu/rss/threads over the root process and every live
// descendant. It returns false when the root process is gone (or the process
// table cannot be scanned) and the loop should stop. When record is false the
// aggregate is discarded — used to establish CPU-diff baselines.
func (s *Sampler) sampleOnce(ctx context.Context, record bool) bool {
	pids, err := descendantPids(ctx, int32(s.Pid))
	if err != nil {
		if !errors.Is(err, errProcessGone) {
			log.Printf("dftstream: failed to scan process tree: %v", err)
		}
		return false
	}

	var cpu float64
	var rssBytes uint64
	var threads int
	live := make(map[int32]struct{}, len(pids))
	for _, pid := range pids {
		h := s.handles[pid]
		if h == nil {
			h, err = process.NewProcessWithContext(ctx, pid)
			if err != nil {
				continue // exited between the tree scan and here — expected churn
			}
			s.handles[pid] = h
		}
		live[pid] = struct{}{}
		// Per-process read errors below mean the process exited mid-sample;
		// the aggregate simply omits it and the next tick prunes the handle.
		// The c > 0 guard drops the (harmless) first-call zero and any
		// negative artifact from pid reuse.
		if c, err := h.PercentWithContext(ctx, 0); err == nil && c > 0 {
			cpu += c
		}
		if mi, err := h.MemoryInfoWithContext(ctx); err == nil {
			rssBytes += mi.RSS
		}
		if n, err := h.NumThreadsWithContext(ctx); err == nil {
			threads += int(n)
		}
	}
	// Prune handles of processes that are no longer in the tree so pid reuse
	// cannot diff against a dead process's CPU state.
	for pid := range s.handles {
		if _, ok := live[pid]; !ok {
			delete(s.handles, pid)
		}
	}

	if !record {
		return true
	}
	if err := s.Tracker.AppendSysSample(ctx, s.RunID, tracker.SysSample{
		TS:      time.Now(),
		CPUPct:  cpu,
		RSSMB:   float64(rssBytes) / 1024 / 1024,
		Threads: threads,
	}); err != nil {
		// A tracker append error is transient (e.g. a momentarily full batch
		// queue) — log and keep sampling. Only a gone root process above means
		// the loop should stop.
		log.Printf("dftstream: failed to record system sample: %v", err)
	}
	return true
}
