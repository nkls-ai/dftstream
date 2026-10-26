package runner

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/nkls-ai/dftstream/internal/fsutil"
	"github.com/nkls-ai/dftstream/internal/levels"
	"github.com/nkls-ai/dftstream/internal/parser"
)

// gbwSnapshotter retains a copy of the .gbw after each optimization
// cycle so per-cycle orbital cubes can be generated once the run ends.
// Copies land in a temp scratch dir — never into the user's working
// directory — and orca_plot later runs against those copies, so the
// original ORCA files are never modified.
type gbwSnapshotter struct {
	scratch string // "" when disabled or scratch creation failed
	workDir string
	stem    string
	geomOpt bool
	stderr  io.Writer

	mu     sync.Mutex
	cycles map[int]bool
	wg     sync.WaitGroup
}

// newGbwSnapshotter allocates the scratch dir when per-cycle orbital
// mode is on. geomOpt gates snapshotting itself: GOAT / SCAN / NEB / MD /
// IRC all also print FINAL SINGLE POINT ENERGY many times over, and
// snapshotting each would explode cube count (GOAT can SP hundreds of
// conformers).
func newGbwSnapshotter(opts Options, geomOpt bool, workDir, stem string) *gbwSnapshotter {
	s := &gbwSnapshotter{
		workDir: workDir,
		stem:    stem,
		geomOpt: geomOpt,
		stderr:  opts.Stderr,
		cycles:  map[int]bool{},
	}
	if opts.OrbitalMode != levels.OrbitalsPerCycle {
		return s
	}
	dir, err := os.MkdirTemp("", "dftstream-snap-")
	if err != nil {
		fmt.Fprintf(opts.Stderr, "[dftstream] per-cycle snapshots disabled (scratch dir: %v)\n", err)
		return s
	}
	s.scratch = dir
	return s
}

// observe snapshots the .gbw after each opt cycle's FINAL SP is printed.
// FINAL SINGLE POINT ENERGY appears AFTER all post-SCF analysis for that
// cycle has been written to disk, so the .gbw is in a stable state
// shortly thereafter. The actual copy runs in a goroutine that waits for
// the file size to settle, so the event pump doesn't stall on
// filesystem latency. ORCA overwrites .gbw between cycles, so this is
// the only way to retain per-cycle wavefunctions without a re-run.
func (s *gbwSnapshotter) observe(ev parser.Event) {
	if s.scratch == "" || !s.geomOpt {
		return
	}
	sp, ok := ev.(parser.FinalSPEvent)
	if !ok || sp.Cycle <= 0 {
		return
	}
	s.wg.Add(1)
	go func(cycle int) {
		defer s.wg.Done()
		src := filepath.Join(s.workDir, s.stem+".gbw")
		dst := filepath.Join(s.scratch, fmt.Sprintf("%s.c%03d.gbw", s.stem, cycle))
		if !waitForStableSize(src, 2*time.Second) {
			return
		}
		if err := fsutil.CopyFile(src, dst); err != nil {
			// Losing one snapshot only costs that cycle's cubes;
			// say so instead of silently skipping.
			fmt.Fprintf(s.stderr, "[dftstream] warning: cycle %d .gbw snapshot failed: %v\n", cycle, err)
			return
		}
		s.mu.Lock()
		s.cycles[cycle] = true
		s.mu.Unlock()
	}(sp.Cycle)
}

// wait blocks until all in-flight copies finish. Must run before
// cleanup — otherwise copies race the recursive delete of the dir they
// are copying into.
func (s *gbwSnapshotter) wait() { s.wg.Wait() }

func (s *gbwSnapshotter) scratchDir() string { return s.scratch }

func (s *gbwSnapshotter) snapshotCycles() []int {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]int, 0, len(s.cycles))
	for c := range s.cycles {
		out = append(out, c)
	}
	return out
}

func (s *gbwSnapshotter) cleanup() {
	if s.scratch == "" {
		return
	}
	if err := os.RemoveAll(s.scratch); err != nil {
		fmt.Fprintf(s.stderr, "[dftstream] warning: could not remove snapshot scratch %s: %v\n", s.scratch, err)
	}
}

// waitForStableSize returns true once src's size has stopped growing
// for two consecutive 50 ms samples or `maxWait` has elapsed. We use
// this to wait for ORCA to flush a .gbw before snapshotting it.
func waitForStableSize(src string, maxWait time.Duration) bool {
	deadline := time.Now().Add(maxWait)
	var last int64 = -1
	stable := 0
	for time.Now().Before(deadline) {
		info, err := os.Stat(src)
		if err != nil {
			time.Sleep(50 * time.Millisecond)
			continue
		}
		if info.Size() == last && info.Size() > 0 {
			stable++
			if stable >= 2 {
				return true
			}
		} else {
			stable = 0
		}
		last = info.Size()
		time.Sleep(50 * time.Millisecond)
	}
	return last > 0
}
