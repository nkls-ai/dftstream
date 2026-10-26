package cli

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRunCmdRequiresOrcaPath(t *testing.T) {
	t.Setenv("DFTSTREAM_ORCA", "")
	t.Setenv("DFTSTREAM_TRACKER_URL", "noop://")

	dir := t.TempDir()
	input := filepath.Join(dir, "h2.inp")
	if err := os.WriteFile(input, []byte("! SP\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if code := RunCmd([]string{input}); code != 2 {
		t.Fatalf("RunCmd without ORCA path exit code = %d, want 2", code)
	}
}

func TestRunCmdAcceptsOrcaPathFromEnv(t *testing.T) {
	t.Setenv("DFTSTREAM_TRACKER_URL", "noop://")

	dir := t.TempDir()
	input := filepath.Join(dir, "h2.inp")
	if err := os.WriteFile(input, []byte("! SP\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	orca := filepath.Join(dir, "orca")
	if err := os.WriteFile(orca, []byte("#!/bin/sh\nprintf 'FINAL SINGLE POINT ENERGY      -1.234\\n'\nprintf 'ORCA TERMINATED NORMALLY\\n'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DFTSTREAM_ORCA", orca)

	if code := RunCmd([]string{input}); code != 0 {
		t.Fatalf("RunCmd with ORCA path from env exit code = %d, want 0", code)
	}
}

// The pre-flight lint is advisory: even an input with an error-severity
// finding (impossible charge/multiplicity) must not block the run.
func TestRunCmdLintNeverBlocksTheRun(t *testing.T) {
	t.Setenv("DFTSTREAM_TRACKER_URL", "noop://")

	dir := t.TempDir()
	input := filepath.Join(dir, "h2o.inp")
	// Water (10 electrons) as a doublet — lint flags charge-mult-parity.
	badInput := "! SP\n* xyz 0 2\nO 0 0 0\nH 0 0 0.96\nH 0.9 0 0\n*\n"
	if err := os.WriteFile(input, []byte(badInput), 0o644); err != nil {
		t.Fatal(err)
	}
	orca := filepath.Join(dir, "orca")
	if err := os.WriteFile(orca, []byte("#!/bin/sh\nprintf 'ORCA TERMINATED NORMALLY\\n'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DFTSTREAM_ORCA", orca)

	if code := RunCmd([]string{input}); code != 0 {
		t.Fatalf("RunCmd with lint-error input exit code = %d, want 0 (lint is advisory)", code)
	}
	// And the kill switches work end-to-end.
	t.Setenv("DFTSTREAM_LINT", "off")
	if code := RunCmd([]string{input}); code != 0 {
		t.Fatalf("RunCmd with DFTSTREAM_LINT=off exit code = %d, want 0", code)
	}
	t.Setenv("DFTSTREAM_LINT", "")
	if code := RunCmd([]string{"-lint", "off", input}); code != 0 {
		t.Fatalf("RunCmd with -lint off exit code = %d, want 0", code)
	}
}

func TestRunCmdRejectsInvalidLintValue(t *testing.T) {
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

	if code := RunCmd([]string{"-lint", "bogus", input}); code != 2 {
		t.Fatalf("RunCmd with -lint bogus exit code = %d, want 2", code)
	}
}
