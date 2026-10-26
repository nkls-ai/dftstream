package cli

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDiscoverImportJobs(t *testing.T) {
	root := t.TempDir()

	// expA / run1 / stem.inp + stem.out  ← match by stem
	mkRun(t, root, "expA", "run1", map[string]string{
		"h2o.inp":   "! HF def2-SVP\n",
		"h2o.out":   "ORCA TERMINATED NORMALLY\n",
		"other.dat": "ignored\n",
	})
	// expA / run2 / no .out  ← skipped
	mkRun(t, root, "expA", "run2", map[string]string{
		"x.inp": "! HF\n",
	})
	// expB / run3 / mismatched stems  ← fallback to lexicographic pair
	mkRun(t, root, "expB", "run3", map[string]string{
		"a.inp": "! HF\n",
		"b.out": "ORCA\n",
	})

	jobs, err := discoverImportJobs(root)
	if err != nil {
		t.Fatalf("discoverImportJobs: %v", err)
	}
	if len(jobs) != 2 {
		t.Fatalf("got %d jobs, want 2: %+v", len(jobs), jobs)
	}
	// Sorted alphabetically by experiment then run.
	if jobs[0].Experiment != "expA" || jobs[0].Run != "run1" {
		t.Errorf("job 0 = %s/%s, want expA/run1", jobs[0].Experiment, jobs[0].Run)
	}
	if filepath.Base(jobs[0].InputPath) != "h2o.inp" ||
		filepath.Base(jobs[0].OutputPath) != "h2o.out" {
		t.Errorf("job 0 paths = %s + %s, want h2o.inp/h2o.out",
			jobs[0].InputPath, jobs[0].OutputPath)
	}
	if jobs[1].Experiment != "expB" {
		t.Errorf("job 1 experiment = %s, want expB", jobs[1].Experiment)
	}
}

func mkRun(t *testing.T, root, exp, run string, files map[string]string) {
	t.Helper()
	dir := filepath.Join(root, exp, run)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}
