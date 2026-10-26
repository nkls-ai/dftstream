//go:build linux

package sysinfo

import (
	"context"
	"os"
	"testing"
)

func TestPpidFromStat(t *testing.T) {
	cases := []struct {
		name string
		stat string
		want int32
		ok   bool
	}{
		{
			name: "plain comm",
			stat: "1234 (orca) S 987 1234 987 0 -1 4194304 1 0 0 0",
			want: 987,
			ok:   true,
		},
		{
			name: "comm with spaces and parens",
			stat: "42 (my (weird) proc) R 7 42 7 0 -1 0 0",
			want: 7,
			ok:   true,
		},
		{
			name: "truncated line",
			stat: "42 (x)",
			ok:   false,
		},
		{
			name: "no closing paren",
			stat: "garbage",
			ok:   false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := ppidFromStat(tc.stat)
			if ok != tc.ok || got != tc.want {
				t.Fatalf("ppidFromStat(%q) = (%d, %v), want (%d, %v)", tc.stat, got, ok, tc.want, tc.ok)
			}
		})
	}
}

func TestDescendantPidsIncludesSelf(t *testing.T) {
	self := int32(os.Getpid())
	pids, err := descendantPids(context.Background(), self)
	if err != nil {
		t.Fatalf("descendantPids(self): %v", err)
	}
	if len(pids) == 0 || pids[0] != self {
		t.Fatalf("descendantPids(self) = %v, want first element %d", pids, self)
	}
}

func TestDescendantPidsGoneRoot(t *testing.T) {
	// Pid 0 never appears as a /proc entry, so the root is "gone".
	if _, err := descendantPids(context.Background(), 0); err != errProcessGone {
		t.Fatalf("descendantPids(0) err = %v, want errProcessGone", err)
	}
}
