package inputbuild

import (
	"fmt"
	"math"
	"strings"
)

// Resources is the machine allocation: %pal nprocs and %maxcore (MB per
// core). Zero values omit the corresponding line, leaving ORCA's own
// defaults in place.
type Resources struct {
	NProcs    int
	MaxCoreMB int
}

// Render emits the resource lines (each newline-terminated).
func (r Resources) Render() string {
	var b strings.Builder
	if r.NProcs > 0 {
		fmt.Fprintf(&b, "%%pal nprocs %d end\n", r.NProcs)
	}
	if r.MaxCoreMB > 0 {
		fmt.Fprintf(&b, "%%maxcore %d\n", r.MaxCoreMB)
	}
	return b.String()
}

// safeMemoryFraction is the share of physical RAM an ORCA job may
// request. ORCA treats %maxcore as a soft target and overshoots it, so
// the last quarter is the safety margin that keeps the OOM killer away.
// internal/inputlint warns above exactly this line.
const safeMemoryFraction = 0.75

// MaxCoreMB returns the per-core %maxcore (MB) for a machine with
// totalRAMMB of memory running nprocs ranks, using the 75%-of-RAM rule.
// Rounded to whole GB per core, matching the group's existing tooling.
// Returns 0 when the inputs are non-positive or the share rounds below
// 1 GB per core — the caller then leaves %maxcore out rather than
// emitting a value ORCA would choke on.
func MaxCoreMB(totalRAMMB, nprocs int) int {
	if totalRAMMB <= 0 || nprocs <= 0 {
		return 0
	}
	perCoreGB := math.Round(float64(totalRAMMB) / 1024 * safeMemoryFraction / float64(nprocs))
	if perCoreGB < 1 {
		return 0
	}
	return int(perCoreGB) * 1000
}
