package submit

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func planOne(t *testing.T) (Request, Job) {
	t.Helper()
	req := testRequest(t, map[string]string{"opt-freq_x.inp": realInput}, "ma1-tbu.xyz")
	jobs, err := Plan(req)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	return req, jobs[0]
}

func TestMaterializeStagesEverything(t *testing.T) {
	_, job := planOne(t)
	if err := Materialize(job, false); err != nil {
		t.Fatalf("Materialize: %v", err)
	}
	for _, name := range []string{"opt-freq_x.inp", "ma1-tbu.xyz", "opt-freq_x.sh"} {
		if _, err := os.Stat(filepath.Join(job.Dir, name)); err != nil {
			t.Errorf("%s not staged: %v", name, err)
		}
	}
	info, err := os.Stat(job.ScriptPath)
	if err != nil {
		t.Fatalf("stat script: %v", err)
	}
	if info.Mode().Perm()&0o100 == 0 {
		t.Errorf("script mode = %v, want executable", info.Mode().Perm())
	}
}

func TestMaterializeLeavesSourcesAlone(t *testing.T) {
	req, job := planOne(t)
	before := readAll(t, filepath.Join(req.SourceDir, "opt-freq_x.inp"))
	if err := Materialize(job, false); err != nil {
		t.Fatalf("Materialize: %v", err)
	}
	if after := readAll(t, filepath.Join(req.SourceDir, "opt-freq_x.inp")); after != before {
		t.Error("the source input was modified; staging must only ever copy")
	}
}

func TestMaterializeRefusesExistingDir(t *testing.T) {
	req, _ := planOne(t)
	first, err := Plan(req)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	if err := Materialize(first[0], false); err != nil {
		t.Fatalf("Materialize: %v", err)
	}
	// A second plan sees the directory that now exists.
	second, err := Plan(req)
	if err != nil {
		t.Fatalf("re-Plan: %v", err)
	}
	err = Materialize(second[0], false)
	if !errors.Is(err, ErrJobDirExists) {
		t.Fatalf("got %v, want ErrJobDirExists", err)
	}
	// Results already there survive the refusal.
	writeFile(t, filepath.Join(second[0].Dir, "opt-freq_x.out"), "ORCA TERMINATED NORMALLY\n")
	if err := Materialize(second[0], false); !errors.Is(err, ErrJobDirExists) {
		t.Fatalf("got %v, want ErrJobDirExists", err)
	}
	if _, err := os.Stat(filepath.Join(second[0].Dir, "opt-freq_x.out")); err != nil {
		t.Errorf("existing result was removed by a refused staging: %v", err)
	}
	// -force clears it.
	if err := Materialize(second[0], true); err != nil {
		t.Fatalf("forced Materialize: %v", err)
	}
	if _, err := os.Stat(filepath.Join(second[0].Dir, "opt-freq_x.out")); !os.IsNotExist(err) {
		t.Error("-force should have replaced the directory")
	}
}

func TestRemoveJobDirRefusesStrangePaths(t *testing.T) {
	for name, job := range map[string]Job{
		"empty name": {Name: "", Dir: t.TempDir()},
		"name does not match": {
			Name: "job", Dir: filepath.Join(t.TempDir(), "something-else"),
		},
	} {
		t.Run(name, func(t *testing.T) {
			if err := removeJobDir(job); err == nil {
				t.Fatal("expected a refusal")
			}
		})
	}
}

func TestMaterializeArrayWritesList(t *testing.T) {
	req := testRequest(t, map[string]string{"a.inp": realInput, "b.inp": realInput}, "ma1-tbu.xyz")
	req.Array = true
	jobs, err := Plan(req)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	if err := Materialize(jobs[0], false); err != nil {
		t.Fatalf("Materialize: %v", err)
	}
	if got := readAll(t, jobs[0].ListPath); got != "a.inp ma1-tbu.xyz\nb.inp ma1-tbu.xyz\n" {
		t.Errorf("input_list.txt = %q", got)
	}
}

func readAll(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}
