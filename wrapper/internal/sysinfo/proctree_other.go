//go:build !linux

package sysinfo

import (
	"context"

	"github.com/shirou/gopsutil/v3/process"
)

// descendantPids returns root plus every live descendant pid, breadth-first,
// via gopsutil's per-process child lookup. Linux has a cheaper single-scan
// implementation in proctree_linux.go.
func descendantPids(ctx context.Context, root int32) ([]int32, error) {
	p, err := process.NewProcessWithContext(ctx, root)
	if err != nil {
		return nil, errProcessGone
	}
	pids := []int32{root}
	seen := map[int32]struct{}{root: {}}
	frontier := []*process.Process{p}
	for len(frontier) > 0 {
		cur := frontier[0]
		frontier = frontier[1:]
		kids, err := cur.ChildrenWithContext(ctx)
		if err != nil {
			continue // ErrorNoChildren, or the process exited — subtree ends here
		}
		for _, k := range kids {
			if _, ok := seen[k.Pid]; ok {
				continue // guard against a cyclic/duplicated child listing
			}
			seen[k.Pid] = struct{}{}
			pids = append(pids, k.Pid)
			frontier = append(frontier, k)
		}
	}
	return pids, nil
}
