package runner

import (
	"testing"
	"time"
)

func TestParseProfile(t *testing.T) {
	cases := map[string]Profile{
		"":            ProfileDefault,
		"default":     ProfileDefault,
		"interactive": ProfileDefault,
		"throughput":  ProfileThroughput,
		"THROUGHPUT":  ProfileThroughput,
		" batch ":     ProfileThroughput,
	}
	for in, want := range cases {
		got, err := ParseProfile(in)
		if err != nil {
			t.Errorf("ParseProfile(%q): %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("ParseProfile(%q) = %q, want %q", in, got, want)
		}
	}
	if _, err := ParseProfile("turbo"); err == nil {
		t.Error("ParseProfile accepted an unknown profile")
	}
}

// The default profile must impose nothing: an interactive run keeps every
// SCF iteration, and the tracker is not even wrapped.
func TestDefaultProfileImposesNoLimits(t *testing.T) {
	if !ProfileDefault.SamplingLimits().IsZero() {
		t.Fatal("the default profile must not decimate anything")
	}
	if ProfileThroughput.SamplingLimits().IsZero() {
		t.Fatal("the throughput profile must impose limits")
	}
}

// The bound the profile advertises has to be a real constant — every
// category capped, nothing left open-ended.
func TestThroughputProfileCapsEveryCategory(t *testing.T) {
	l := ProfileThroughput.SamplingLimits()
	for name, v := range map[string]int{
		"MaxMetricsTotal": l.MaxMetricsTotal,
		"MaxEventsTotal":  l.MaxEventsTotal,
		"MaxGeometries":   l.MaxGeometries,
		"MaxSysSamples":   l.MaxSysSamples,
		"MaxLogs":         l.MaxLogs,
	} {
		if v <= 0 {
			t.Errorf("%s = %d: an uncapped category makes rows-per-run unbounded", name, v)
		}
	}
	if got := l.MaxRowsPerRun(20); got > 5000 {
		t.Errorf("throughput row bound = %d, larger than the profile claims", got)
	}
	if ThroughputSysInterval != 60*time.Second {
		t.Errorf("ThroughputSysInterval = %v, want 60s", ThroughputSysInterval)
	}
}
