package submit

import (
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// testRequest builds a request against the shipped example cluster with one
// real input staged in a temp source directory.
func testRequest(t *testing.T, inputs map[string]string, extra ...string) Request {
	t.Helper()
	cfg, err := ParseConfig(DefaultConfigYAML())
	if err != nil {
		t.Fatalf("parse config: %v", err)
	}
	cluster, err := cfg.ClusterNamed("")
	if err != nil {
		t.Fatalf("cluster: %v", err)
	}
	profile, err := cluster.ProfileNamed("")
	if err != nil {
		t.Fatalf("profile: %v", err)
	}
	src := t.TempDir()
	names := make([]string, 0, len(inputs))
	for name, body := range inputs {
		writeFile(t, filepath.Join(src, name), body)
		names = append(names, name)
	}
	sort.Strings(names) // map iteration order must not reach the array list
	for _, dep := range extra {
		writeFile(t, filepath.Join(src, dep), "1\n\nH 0 0 0\n")
	}
	return Request{
		Cluster:    cluster,
		Profile:    profile,
		SourceDir:  src,
		JobsDir:    filepath.Join(src, "..", "jobs"),
		Inputs:     names,
		Experiment: "CCC_SeO",
		Stream:     true,
	}
}

func TestPlanSingleJob(t *testing.T) {
	req := testRequest(t, map[string]string{"opt-freq_x.inp": realInput}, "ma1-tbu.xyz")
	jobs, err := Plan(req)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	if len(jobs) != 1 {
		t.Fatalf("got %d jobs, want 1", len(jobs))
	}
	job := jobs[0]
	if job.Name != "opt-freq_x" {
		t.Errorf("name = %q", job.Name)
	}
	if len(job.Files) != 2 {
		t.Fatalf("staged %v, want the input and its .xyz", job.Files)
	}
	if filepath.Base(job.Files[1].Src) != "ma1-tbu.xyz" {
		t.Errorf("second staged file = %q, want the referenced geometry", job.Files[1].Src)
	}

	for _, want := range []string{
		"#SBATCH --job-name=opt-freq_x",
		"#SBATCH --ntasks=8",
		"#SBATCH --mem=32G",
		"#SBATCH --time=24:00:00",
		"trap cleanup EXIT TERM INT",
		"dftstream run -artifacts essential -orbitals none -exp CCC_SeO",
		`-orca /path/to/orca opt-freq_x.inp -- "--bind-to none" > opt-freq_x.out`,
	} {
		if !strings.Contains(job.Script, want) {
			t.Errorf("script is missing %q\n%s", want, job.Script)
		}
	}
	// The default queue is the cluster's; naming it buys nothing.
	if strings.Contains(job.Script, "--partition") {
		t.Error("default profile should not emit a partition directive")
	}
	// SOURCE must not depend on where sbatch was run from.
	if !strings.Contains(job.Script, "SOURCE="+job.Dir+"\n") {
		t.Errorf("SOURCE should be the absolute job directory\n%s", job.Script)
	}
}

func TestPlanSingleJobWithoutStream(t *testing.T) {
	req := testRequest(t, map[string]string{"x.inp": realInput}, "ma1-tbu.xyz")
	req.Stream = false
	jobs, err := Plan(req)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	script := jobs[0].Script
	if strings.Contains(script, "dftstream run") {
		t.Error("-stream=false should call ORCA directly")
	}
	if !strings.Contains(script, `/path/to/orca x.inp "--bind-to none" > x.out`) {
		t.Errorf("plain ORCA line missing\n%s", script)
	}
}

func TestPlanArray(t *testing.T) {
	req := testRequest(t, map[string]string{
		"a.inp": realInput,
		"b.inp": realInput,
	}, "ma1-tbu.xyz")
	req.Array = true
	req.ArrayName = "rerun"
	arrayProfile, err := req.Cluster.ProfileNamed("array")
	if err != nil {
		t.Fatalf("array profile: %v", err)
	}
	req.Profile = arrayProfile

	jobs, err := Plan(req)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	if len(jobs) != 1 {
		t.Fatalf("an array is one job, got %d", len(jobs))
	}
	job := jobs[0]
	if !job.Array || job.Name != "rerun" {
		t.Fatalf("got %+v", job)
	}
	// A shared dependency is staged once.
	if len(job.Files) != 3 {
		t.Errorf("staged %v, want two inputs and one shared .xyz", job.Files)
	}
	if job.ListBody != "a.inp ma1-tbu.xyz\nb.inp ma1-tbu.xyz\n" {
		t.Errorf("input list = %q", job.ListBody)
	}
	for _, want := range []string{
		"#SBATCH --array=1-2%30",
		"#SBATCH --partition=cpu",
		"#SBATCH --time=48:00:00",
		`LINE=$(sed -n "${SLURM_ARRAY_TASK_ID}p" "$LIST")`,
		`if grep -q "ORCA TERMINATED NORMALLY" "$SOURCE/${FILENAME}.out" 2>/dev/null; then`,
		"exit 0",
		`copy_back "*.out" "*.xyz" "*.hess"`,
		`"$INPUT" -- "--bind-to none" > "${FILENAME}.out"`,
	} {
		if !strings.Contains(job.Script, want) {
			t.Errorf("array script is missing %q\n%s", want, job.Script)
		}
	}
}

func TestPlanArrayThrottleOverride(t *testing.T) {
	req := testRequest(t, map[string]string{"a.inp": realInput}, "ma1-tbu.xyz")
	req.Array = true
	req.Throttle = 4
	jobs, err := Plan(req)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	if !strings.Contains(jobs[0].Script, "--array=1-1%4") {
		t.Errorf("throttle override not applied\n%s", jobs[0].Script)
	}
}

func TestPlanSecondClusterChangesTheScript(t *testing.T) {
	req := testRequest(t, map[string]string{"x.inp": realInput}, "ma1-tbu.xyz")
	cfg, err := ParseConfig(DefaultConfigYAML())
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	modules, err := cfg.ClusterNamed("modules")
	if err != nil {
		t.Fatalf("modules: %v", err)
	}
	profile, err := modules.ProfileNamed("")
	if err != nil {
		t.Fatalf("profile: %v", err)
	}
	req.Cluster, req.Profile = modules, profile
	jobs, err := Plan(req)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	for _, want := range []string{
		"#SBATCH --ntasks-per-node=8",
		"#SBATCH --partition=normal",
		"module load ORCA/6.1.1",
		"TMP=/scratch/$USER/x/$SLURM_JOB_ID",
		`clean_scratch "*tmp*" "*pro*"`,
	} {
		if !strings.Contains(jobs[0].Script, want) {
			t.Errorf("modules script is missing %q\n%s", want, jobs[0].Script)
		}
	}
}

func TestPlanReportsBadInput(t *testing.T) {
	req := testRequest(t, map[string]string{"x.inp": "! r2SCAN-3c Opt\n* xyzfile 0 1 gone.xyz\n"})
	if _, err := Plan(req); err == nil || !strings.Contains(err.Error(), "x.inp") {
		t.Fatalf("got %v, want an error naming the input", err)
	}
}
