//go:build linux

package sysinfo

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// descendantPids returns root plus every live descendant pid, breadth-first.
// One /proc directory scan per call — deliberately no pgrep (gopsutil's
// ChildrenWithContext forks a pgrep process per node per tick, and pgrep may
// be absent on minimal cluster images).
func descendantPids(_ context.Context, root int32) ([]int32, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, fmt.Errorf("read /proc: %w", err)
	}
	children := make(map[int32][]int32)
	rootSeen := false
	for _, e := range entries {
		pid64, err := strconv.ParseInt(e.Name(), 10, 32)
		if err != nil {
			continue // non-pid entry such as /proc/meminfo
		}
		pid := int32(pid64)
		if pid == root {
			rootSeen = true
		}
		ppid, ok := statPpid(pid)
		if !ok {
			continue // exited between ReadDir and the stat read — expected churn
		}
		children[ppid] = append(children[ppid], pid)
	}
	if !rootSeen {
		return nil, errProcessGone
	}
	pids := []int32{root}
	for i := 0; i < len(pids); i++ {
		pids = append(pids, children[pids[i]]...)
	}
	return pids, nil
}

// statPpid reads the parent pid of pid from /proc/<pid>/stat.
func statPpid(pid int32) (int32, bool) {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(int(pid)) + "/stat")
	if err != nil {
		return 0, false
	}
	return ppidFromStat(string(b))
}

// ppidFromStat extracts field 4 (ppid) from a /proc/<pid>/stat line. Field 2
// (comm) may itself contain spaces and parentheses, so parsing starts after
// the last ')'.
func ppidFromStat(stat string) (int32, bool) {
	i := strings.LastIndexByte(stat, ')')
	if i < 0 {
		return 0, false
	}
	fields := strings.Fields(stat[i+1:])
	// fields[0] is state, fields[1] is ppid.
	if len(fields) < 2 {
		return 0, false
	}
	ppid, err := strconv.ParseInt(fields[1], 10, 32)
	if err != nil {
		return 0, false
	}
	return int32(ppid), true
}
