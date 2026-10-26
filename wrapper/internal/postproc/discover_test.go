package postproc

import (
	"os"
	"path/filepath"
	"sort"
	"testing"
)

func TestDiscoverIntermediateHessiansDotPattern(t *testing.T) {
	dir := t.TempDir()
	stem := "mol"
	touch(t, filepath.Join(dir, "mol.001.hess"))
	touch(t, filepath.Join(dir, "mol.002.hess"))
	touch(t, filepath.Join(dir, "mol.hess")) // final — should not match
	touch(t, filepath.Join(dir, "mol.out"))  // unrelated

	got := DiscoverIntermediateHessians(dir, stem)
	sort.Strings(got)
	if len(got) != 2 {
		t.Fatalf("got %d files, want 2: %v", len(got), got)
	}
	if filepath.Base(got[0]) != "mol.001.hess" {
		t.Errorf("got[0] = %s", filepath.Base(got[0]))
	}
	if filepath.Base(got[1]) != "mol.002.hess" {
		t.Errorf("got[1] = %s", filepath.Base(got[1]))
	}
}

func TestDiscoverIntermediateHessiansUnderscorePattern(t *testing.T) {
	dir := t.TempDir()
	touch(t, filepath.Join(dir, "h2o_001.hess"))
	touch(t, filepath.Join(dir, "h2o_002.hess"))

	got := DiscoverIntermediateHessians(dir, "h2o")
	if len(got) != 2 {
		t.Fatalf("got %d files, want 2: %v", len(got), got)
	}
}

func TestDiscoverIntermediateHessiansEmpty(t *testing.T) {
	dir := t.TempDir()
	touch(t, filepath.Join(dir, "mol.hess"))

	got := DiscoverIntermediateHessians(dir, "mol")
	if len(got) != 0 {
		t.Fatalf("got %d files, want 0: %v", len(got), got)
	}
}

func TestDiscoverIntermediateHessiansMixedPatterns(t *testing.T) {
	dir := t.TempDir()
	touch(t, filepath.Join(dir, "test.001.hess"))
	touch(t, filepath.Join(dir, "test_002.hess"))

	got := DiscoverIntermediateHessians(dir, "test")
	if len(got) != 2 {
		t.Fatalf("got %d files, want 2: %v", len(got), got)
	}
}

func touch(t *testing.T, path string) {
	t.Helper()
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		t.Fatal(err)
	}
}
