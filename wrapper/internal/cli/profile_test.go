package cli

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nkls-ai/dftstream/internal/levels"
	"github.com/nkls-ai/dftstream/internal/logging"
	"github.com/nkls-ai/dftstream/internal/runner"
)

// resolveForTest runs the real flag → option pipeline against a throwaway
// input file, so these assertions cover the precedence rules and not a
// reimplementation of them.
func resolveForTest(t *testing.T, args ...string) runOptions {
	t.Helper()
	dir := t.TempDir()
	input := filepath.Join(dir, "h2o.inp")
	if err := os.WriteFile(input, []byte("! SP\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	orca := filepath.Join(dir, "orca")
	if err := os.WriteFile(orca, []byte("#!/bin/sh\ntrue\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DFTSTREAM_ORCA", orca)
	t.Setenv("DFTSTREAM_TRACKER_URL", "noop://")

	f, err := parseRunFlags(append(args, input))
	if err != nil {
		t.Fatalf("parseRunFlags(%v): %v", args, err)
	}
	opts, err := resolveRunOptions(f)
	if err != nil {
		t.Fatalf("resolveRunOptions(%v): %v", args, err)
	}
	return opts
}

func TestDefaultProfileKeepsInteractiveSettings(t *testing.T) {
	opts := resolveForTest(t)
	if opts.profile != runner.ProfileDefault {
		t.Errorf("profile = %q, want default", opts.profile)
	}
	if opts.sysInterval != defaultSysInterval {
		t.Errorf("sysInterval = %v, want %v", opts.sysInterval, defaultSysInterval)
	}
	if opts.artifactLevel != levels.ArtifactsMedium {
		t.Errorf("artifactLevel = %v, want medium", opts.artifactLevel)
	}
	if opts.orbitalMode != levels.OrbitalsFinal {
		t.Errorf("orbitalMode = %v, want final", opts.orbitalMode)
	}
}

// --profile throughput extends what -batch already does (io artifacts, no
// orbitals) with the wider sampling interval and the log floor.
func TestThroughputProfileAppliesItsDefaults(t *testing.T) {
	opts := resolveForTest(t, "-profile", "throughput")
	if opts.profile != runner.ProfileThroughput {
		t.Fatalf("profile = %q, want throughput", opts.profile)
	}
	if opts.artifactLevel != levels.ArtifactsIO {
		t.Errorf("artifactLevel = %v, want io", opts.artifactLevel)
	}
	if opts.orbitalMode != levels.OrbitalsNone {
		t.Errorf("orbitalMode = %v, want none", opts.orbitalMode)
	}
	if opts.sysInterval != runner.ThroughputSysInterval {
		t.Errorf("sysInterval = %v, want %v", opts.sysInterval, runner.ThroughputSysInterval)
	}
	if opts.logLevel < logging.LevelWarn {
		t.Errorf("logLevel = %v, want warn or higher", opts.logLevel)
	}
	if opts.profile.SamplingLimits().IsZero() {
		t.Error("throughput profile resolved to no row limits")
	}
}

// The log floor holds even against an explicit request: an unbounded row
// count is the thing the profile exists to prevent.
func TestThroughputProfileRaisesAnExplicitDebugLevel(t *testing.T) {
	opts := resolveForTest(t, "-profile", "throughput", "-log-level", "debug")
	if opts.logLevel != logging.LevelWarn {
		t.Errorf("logLevel = %v, want warn (raised from debug)", opts.logLevel)
	}
}

// Everything else the profile touches is a default, not an override.
func TestThroughputProfileYieldsToExplicitFlags(t *testing.T) {
	opts := resolveForTest(t, "-profile", "throughput",
		"-artifacts", "all", "-orbitals", "final", "-sysinterval", "2s")
	if opts.artifactLevel != levels.ArtifactsAll {
		t.Errorf("artifactLevel = %v, want all", opts.artifactLevel)
	}
	if opts.orbitalMode != levels.OrbitalsFinal {
		t.Errorf("orbitalMode = %v, want final", opts.orbitalMode)
	}
	if opts.sysInterval != 2*time.Second {
		t.Errorf("sysInterval = %v, want 2s", opts.sysInterval)
	}
}

func TestRunCmdRejectsUnknownProfile(t *testing.T) {
	t.Setenv("DFTSTREAM_TRACKER_URL", "noop://")
	dir := t.TempDir()
	input := filepath.Join(dir, "h2.inp")
	if err := os.WriteFile(input, []byte("! SP\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	orca := filepath.Join(dir, "orca")
	if err := os.WriteFile(orca, []byte("#!/bin/sh\ntrue\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DFTSTREAM_ORCA", orca)
	if code := RunCmd([]string{"-profile", "ludicrous", input}); code != 2 {
		t.Fatalf("RunCmd with an unknown profile exit code = %d, want 2", code)
	}
}

func TestResolveSysInterval(t *testing.T) {
	t.Setenv("DFTSTREAM_SYSINTERVAL", "")
	cases := []struct {
		flag       string
		throughput bool
		want       time.Duration
	}{
		{"", false, defaultSysInterval},
		{"", true, runner.ThroughputSysInterval},
		{"30s", false, 30 * time.Second},
		{"off", true, 0},
		{"OFF", false, 0},
		{"none", false, 0},
		{"0", false, 0},
	}
	for _, c := range cases {
		got, err := resolveSysInterval(c.flag, c.throughput)
		if err != nil {
			t.Errorf("resolveSysInterval(%q, %v): %v", c.flag, c.throughput, err)
			continue
		}
		if got != c.want {
			t.Errorf("resolveSysInterval(%q, %v) = %v, want %v", c.flag, c.throughput, got, c.want)
		}
	}
	if _, err := resolveSysInterval("banana", false); err == nil {
		t.Error("resolveSysInterval accepted a non-duration")
	}
	if _, err := resolveSysInterval("-5s", false); err == nil {
		t.Error("resolveSysInterval accepted a negative interval")
	}
}
