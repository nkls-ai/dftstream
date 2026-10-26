package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nkls-ai/dftstream/internal/submit"
)

const submitTestInput = `! r2SCAN-3c TightOpt Freq CPCM(DMSO)
%maxcore 3000
%pal
    nprocs 8
end
* xyzfile 0 2 ma1-tbu.xyz
`

// submitProject lays out a project the way these directories are
// organized — inputs in <project>/submit/, jobs in <project>/jobs/ — and
// makes the submit directory current.
func submitProject(t *testing.T, inputs ...string) string {
	t.Helper()
	// Keep the test off any cluster config this machine happens to have,
	// so it exercises the built-in one.
	t.Setenv("DFTSTREAM_CLUSTERS", "")
	t.Setenv("HOME", t.TempDir())
	project := filepath.Join(t.TempDir(), "CCC_SeO")
	src := filepath.Join(project, "submit")
	if err := os.MkdirAll(src, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(src, name), []byte(body), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	write("ma1-tbu.xyz", "1\n\nH 0 0 0\n")
	for _, name := range inputs {
		write(name, submitTestInput)
	}
	t.Chdir(src)
	return project
}

func TestSubmitCmdStagesAndDoesNotQueue(t *testing.T) {
	project := submitProject(t, "opt-freq_x.inp")
	if code := SubmitCmd([]string{"opt-freq_x.inp"}); code != 0 {
		t.Fatalf("exit = %d, want 0", code)
	}
	jobDir := filepath.Join(project, "jobs", "opt-freq_x")
	for _, name := range []string{"opt-freq_x.inp", "ma1-tbu.xyz", "opt-freq_x.sh"} {
		if _, err := os.Stat(filepath.Join(jobDir, name)); err != nil {
			t.Errorf("%s not staged: %v", name, err)
		}
	}
	script, err := os.ReadFile(filepath.Join(jobDir, "opt-freq_x.sh"))
	if err != nil {
		t.Fatalf("read script: %v", err)
	}
	// The experiment name defaults to the project folder holding jobs/.
	if !strings.Contains(string(script), "-exp CCC_SeO") {
		t.Errorf("experiment not derived from the project folder\n%s", script)
	}
}

func TestSubmitCmdDryRunWritesNothing(t *testing.T) {
	project := submitProject(t, "opt-freq_x.inp")
	if code := SubmitCmd([]string{"-dry-run", "opt-freq_x.inp"}); code != 0 {
		t.Fatalf("exit = %d, want 0", code)
	}
	if _, err := os.Stat(filepath.Join(project, "jobs")); !os.IsNotExist(err) {
		t.Errorf("-dry-run created %s/jobs", project)
	}
}

// The built-in config is a template; queueing against /path/to/orca would
// only fail later on a compute node.
func TestSubmitCmdRefusesToQueueWithExamplePaths(t *testing.T) {
	project := submitProject(t, "opt-freq_x.inp")
	if code := SubmitCmd([]string{"-submit", "opt-freq_x.inp"}); code != 1 {
		t.Fatalf("exit = %d, want 1", code)
	}
	if _, err := os.Stat(filepath.Join(project, "jobs")); !os.IsNotExist(err) {
		t.Errorf("refused submit still staged %s/jobs", project)
	}
}

func TestSubmitCmdSkipsExistingUnlessForced(t *testing.T) {
	project := submitProject(t, "opt-freq_x.inp")
	if code := SubmitCmd([]string{"opt-freq_x.inp"}); code != 0 {
		t.Fatalf("first run exit = %d", code)
	}
	result := filepath.Join(project, "jobs", "opt-freq_x", "opt-freq_x.out")
	if err := os.WriteFile(result, []byte("ORCA TERMINATED NORMALLY\n"), 0o644); err != nil {
		t.Fatalf("write result: %v", err)
	}
	// Skipping is not a failure: `submit all` must keep going.
	if code := SubmitCmd([]string{"opt-freq_x.inp"}); code != 0 {
		t.Fatalf("re-run exit = %d, want 0 (skip)", code)
	}
	if _, err := os.Stat(result); err != nil {
		t.Fatalf("existing result was disturbed: %v", err)
	}
	if code := SubmitCmd([]string{"-force", "opt-freq_x.inp"}); code != 0 {
		t.Fatalf("-force exit = %d", code)
	}
	if _, err := os.Stat(result); !os.IsNotExist(err) {
		t.Error("-force should have replaced the job directory")
	}
}

func TestSubmitCmdUsageErrors(t *testing.T) {
	submitProject(t, "opt-freq_x.inp")
	cases := map[string][]string{
		"no arguments":       {},
		"conflicting queues": {"-long", "-express", "opt-freq_x.inp"},
	}
	for name, args := range cases {
		t.Run(name, func(t *testing.T) {
			if code := SubmitCmd(args); code != 2 {
				t.Fatalf("exit = %d, want 2", code)
			}
		})
	}
	t.Run("unknown cluster", func(t *testing.T) {
		if code := SubmitCmd([]string{"-cluster", "nope", "opt-freq_x.inp"}); code != 1 {
			t.Fatalf("exit = %d, want 1", code)
		}
	})
	t.Run("not an input file", func(t *testing.T) {
		if code := SubmitCmd([]string{"ma1-tbu.xyz"}); code != 1 {
			t.Fatalf("exit = %d, want 1", code)
		}
	})
}

func TestSubmitCmdPrintConfigIsParseable(t *testing.T) {
	if code := SubmitCmd([]string{"-print-config"}); code != 0 {
		t.Fatalf("exit = %d, want 0", code)
	}
	if _, err := submit.ParseConfig(submit.DefaultConfigYAML()); err != nil {
		t.Fatalf("printed config does not parse: %v", err)
	}
}

func TestCollectInputs(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"b.inp", "a.inp", "notes.txt"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	got, err := collectInputs(dir, []string{"all"})
	if err != nil {
		t.Fatalf("all: %v", err)
	}
	// Sorted, so an array's task numbering is reproducible.
	if len(got) != 2 || got[0] != "a.inp" || got[1] != "b.inp" {
		t.Fatalf("all → %v", got)
	}
	if _, err := collectInputs(dir, []string{"sub/dir/x.inp"}); err == nil {
		t.Error("a path outside the working directory should be refused")
	}
	if _, err := collectInputs(t.TempDir(), []string{"all"}); err == nil {
		t.Error("an empty directory should report that there is nothing to submit")
	}
}

func TestResolveJobsDir(t *testing.T) {
	got, err := resolveJobsDir("", "../jobs", "/proj/submit")
	if err != nil || got != "/proj/jobs" {
		t.Fatalf("got %q, %v", got, err)
	}
	if got, err := resolveJobsDir("/elsewhere", "../jobs", "/proj/submit"); err != nil || got != "/elsewhere" {
		t.Fatalf("flag should win: got %q, %v", got, err)
	}
	if _, err := resolveJobsDir("", "", "/proj/submit"); err == nil {
		t.Error("no jobs directory anywhere should be an error")
	}
}

func TestProfileNameShorthands(t *testing.T) {
	cfg, err := submit.ParseConfig(submit.DefaultConfigYAML())
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	cluster, err := cfg.ClusterNamed("")
	if err != nil {
		t.Fatalf("cluster: %v", err)
	}
	cases := map[string]struct {
		flags *submitFlags
		want  string
	}{
		"default":  {&submitFlags{}, ""},
		"long":     {&submitFlags{long: true}, "long"},
		"express":  {&submitFlags{express: true}, "express"},
		"array":    {&submitFlags{array: true}, "array"},
		"explicit": {&submitFlags{profile: "cpu", long: true}, "cpu"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if got := profileName(tc.flags, cluster); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}
