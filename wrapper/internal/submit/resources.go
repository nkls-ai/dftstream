package submit

import (
	"fmt"
	"math"

	"github.com/nkls-ai/dftstream/internal/inputlint"
	"github.com/nkls-ai/dftstream/internal/inputparse"
)

// Resources is what the scheduler must reserve for one input.
type Resources struct {
	Threads   int // %pal nprocs
	MaxCoreMB int // %maxcore, per core
	MemoryMB  int // node memory to request
	MemoryGB  int // MemoryMB rounded up, the unit sbatch gets
}

// maxcoreRAMFinding is the inputlint code for "this %maxcore × nprocs
// will not fit". Sizing the request is the inverse of that check.
const maxcoreRAMFinding = "maxcore-exceeds-ram"

// ramSearchCeiling bounds the probe below. %maxcore × nprocs can never
// need more than a few multiples of itself; anything past this means the
// linter rule changed shape and the caller should hear about it rather
// than get a silently wrong number.
const ramSearchCeiling = 64

// ResourcesFor reads the thread and per-core memory request back out of
// an ORCA input and sizes the node memory to reserve.
//
// The size is not computed here. ORCA treats %maxcore as a soft target
// and overshoots it, so inputlint warns once a job's %maxcore × nprocs
// crosses a fixed fraction of the machine's RAM. The memory to request
// is exactly the smallest node that clears that same warning, so this
// asks inputlint rather than restating its fraction — one rule, one
// place, and a change there moves both the warning and the request.
func ResourcesFor(text string) (Resources, error) {
	s := inputparse.Parse(text)
	if s.NProcs == 0 || s.MaxCoreMB == 0 {
		return Resources{}, fmt.Errorf(
			"input does not request resources: need both %%pal nprocs (got %d) and %%maxcore (got %d MB)",
			s.NProcs, s.MaxCoreMB)
	}
	// Guard the product: inputparse saturates a malformed %maxcore at
	// MaxInt, and multiplying that by nprocs would wrap to a negative
	// memory request that sbatch would happily accept.
	if s.MaxCoreMB > math.MaxInt/s.NProcs/ramSearchCeiling {
		return Resources{}, fmt.Errorf(
			"implausible resource request: %%maxcore %d MB × %d procs", s.MaxCoreMB, s.NProcs)
	}
	mb, err := memoryMBFor(text, s.NProcs*s.MaxCoreMB)
	if err != nil {
		return Resources{}, err
	}
	return Resources{
		Threads:   s.NProcs,
		MaxCoreMB: s.MaxCoreMB,
		MemoryMB:  mb,
		// ORCA's %maxcore is MB in decimal units while sbatch's G is
		// GiB, so rounding up here is conservative in the safe direction.
		MemoryGB: ceilDiv(mb, 1000),
	}, nil
}

// memoryMBFor binary-searches the smallest total RAM at which inputlint
// stops flagging this input's %maxcore × nprocs as too large.
func memoryMBFor(text string, requestedMB int) (int, error) {
	fits := func(ramMB int) bool {
		for _, f := range inputlint.Lint(text, inputlint.Options{TotalRAMMB: ramMB}) {
			if f.Code == maxcoreRAMFinding {
				return false
			}
		}
		return true
	}
	// lo never fits (a machine with exactly the requested RAM leaves the
	// overshoot no headroom); grow hi until it does.
	lo, hi := requestedMB, requestedMB
	for !fits(hi) {
		hi *= 2
		if hi > requestedMB*ramSearchCeiling {
			return 0, fmt.Errorf(
				"cannot size memory for %d MB: no node size up to %dx clears inputlint's %s check",
				requestedMB, ramSearchCeiling, maxcoreRAMFinding)
		}
	}
	for lo+1 < hi {
		mid := lo + (hi-lo)/2
		if fits(mid) {
			hi = mid
		} else {
			lo = mid
		}
	}
	if fits(lo) {
		return lo, nil
	}
	return hi, nil
}

func ceilDiv(a, b int) int {
	if a <= 0 {
		return 0
	}
	return (a + b - 1) / b
}
