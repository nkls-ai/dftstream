package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nkls-ai/dftstream/internal/inputlint"
)

// End-to-end tests for `dftstream restart`, driven by the parser's
// failure-catalogue fixtures (one real-message .out per ErrorClass).
// Every fixable class must yield a lint-clean input carrying the expected
// keywords; unfixable classes must exit with the needs-a-human code;
// transient classes with the rerun-as-is code.

const restartFixtureDir = "../parser/testdata"

// restartTestInp matches the input echoed inside the fixtures: an Opt job
// with %maxcore 4000 on a single oxygen atom.
const restartTestInp = "! r2SCAN-3c Opt\n%maxcore 4000\n* xyz 0 1\nO 0.0 0.0 0.0\n*\n"

// stageRestartRun copies a fixture .out into a temp dir as job.out and
// writes job.inp next to it. Returns the .out path and the dir.
func stageRestartRun(t *testing.T, fixture, inp string) (outPath, dir string) {
	t.Helper()
	src, err := os.ReadFile(filepath.Join(restartFixtureDir, fixture))
	if err != nil {
		t.Fatalf("read fixture %s: %v", fixture, err)
	}
	dir = t.TempDir()
	outPath = filepath.Join(dir, "job.out")
	if err := os.WriteFile(outPath, src, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "job.inp"), []byte(inp), 0o644); err != nil {
		t.Fatal(err)
	}
	return outPath, dir
}

// pinRestartRAM pins the machine-RAM source for the out-of-memory fix.
func pinRestartRAM(t *testing.T, mb int) {
	t.Helper()
	old := restartTotalRAMMB
	restartTotalRAMMB = func() int { return mb }
	t.Cleanup(func() { restartTotalRAMMB = old })
}

func requireGeneratedInput(t *testing.T, path string, wantContains []string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("generated input missing: %v", err)
	}
	text := string(b)
	if !strings.HasPrefix(text, "# dftstream: edge=restart ") {
		t.Errorf("generated input has no provenance comment:\n%s", text)
	}
	for _, want := range wantContains {
		if !strings.Contains(text, want) {
			t.Errorf("generated input missing %q:\n%s", want, text)
		}
	}
	findings := inputlint.Lint(text, inputlint.Options{Dir: filepath.Dir(path)})
	if inputlint.HasErrors(findings) {
		t.Errorf("generated input fails lint: %+v\n%s", findings, text)
	}
	return text
}

func TestRestartCmdPerErrorClass(t *testing.T) {
	pinRestartRAM(t, 65536)
	cases := []struct {
		name    string
		fixture string
		inp     string
		gbw     bool
		args    []string

		wantExit     int
		wantFile     bool
		wantContains []string
		wantAbsent   []string
	}{
		{
			name: "scf_not_converged stage 1", fixture: "orca6_scf_not_converged.out", inp: restartTestInp,
			wantExit: 0, wantFile: true,
			wantContains: []string{"SlowConv", "MaxIter 500", "stage 1"},
		},
		{
			name: "out_of_memory raises maxcore", fixture: "orca6_out_of_memory.out", inp: restartTestInp,
			wantExit: 0, wantFile: true,
			// 65536 MB RAM, 1 process → 75% ≈ 48 GB per core.
			wantContains: []string{"%maxcore 48000\n"},
			wantAbsent:   []string{"%maxcore 4000\n"},
		},
		{
			name: "unstable_wavefunction goes unrestricted", fixture: "orca6_unstable_wavefunction.out", inp: restartTestInp,
			wantExit: 0, wantFile: true,
			wantContains: []string{"UKS", "StabPerform true", "StabRestartUHFifUnstable true"},
		},
		{
			name: "opt_max_cycles restarts with wavefunction", fixture: "orca6_opt_max_cycles.out", inp: restartTestInp, gbw: true,
			wantExit: 0, wantFile: true,
			wantContains: []string{"Opt", "Freq", "MORead", "%moinp \"job.gbw\""},
		},
		{
			name: "external_tool_failed is transient", fixture: "orca6_external_tool_failed.out", inp: restartTestInp,
			wantExit: restartExitTransient, wantFile: false,
		},
		{
			name: "disk_or_scratch is transient", fixture: "orca6_disk_or_scratch.out", inp: restartTestInp,
			wantExit: restartExitTransient, wantFile: false,
		},
		{
			name: "unknown abort is transient", fixture: "orca6_unknown_abort.out", inp: restartTestInp,
			wantExit: restartExitTransient, wantFile: false,
		},
		{
			name: "charge_mult_impossible needs a human", fixture: "orca6_charge_mult_impossible.out", inp: restartTestInp,
			wantExit: restartExitNeedsHuman, wantFile: false,
		},
		{
			name: "basis_or_ecp_missing needs a human", fixture: "orca6_basis_or_ecp_missing.out", inp: restartTestInp,
			wantExit: restartExitNeedsHuman, wantFile: false,
		},
		{
			name: "input_error needs a human", fixture: "orca6_input_error.out", inp: restartTestInp,
			wantExit: restartExitNeedsHuman, wantFile: false,
		},
		{
			name: "geometry_exploded needs a human", fixture: "orca6_geometry_exploded.out", inp: restartTestInp,
			wantExit: restartExitNeedsHuman, wantFile: false,
		},
		{
			// The false-positive guard output with a plain SP input: clean,
			// nothing to restart.
			name: "clean run writes nothing", fixture: "orca6_clean_near_misses.out",
			inp:      "! HF def2-SVP\n* xyz 0 1\nO 0.0 0.0 0.0\n*\n",
			wantExit: 0, wantFile: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			outPath, dir := stageRestartRun(t, tc.fixture, tc.inp)
			if tc.gbw {
				if err := os.WriteFile(filepath.Join(dir, "job.gbw"), []byte("fake gbw"), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			code := RestartCmd(append(tc.args, outPath))
			if code != tc.wantExit {
				t.Fatalf("exit code = %d, want %d", code, tc.wantExit)
			}
			dest := filepath.Join(dir, "job_restart.inp")
			if !tc.wantFile {
				if _, err := os.Stat(dest); err == nil {
					t.Fatalf("no restart input expected, but %s exists", dest)
				}
				return
			}
			text := requireGeneratedInput(t, dest, tc.wantContains)
			for _, absent := range tc.wantAbsent {
				if strings.Contains(text, absent) {
					t.Errorf("generated input still contains %q:\n%s", absent, text)
				}
			}
		})
	}
}

// TestRestartCmdTransientForce: -f/--force turns the rerun-as-is advice
// into a written input — same job, restart wavefunction.
func TestRestartCmdTransientForce(t *testing.T) {
	outPath, dir := stageRestartRun(t, "orca6_external_tool_failed.out", restartTestInp)
	if err := os.WriteFile(filepath.Join(dir, "job.gbw"), []byte("fake gbw"), 0o644); err != nil {
		t.Fatal(err)
	}
	if code := RestartCmd([]string{"--force", outPath}); code != 0 {
		t.Fatalf("exit code = %d, want 0", code)
	}
	text := requireGeneratedInput(t, filepath.Join(dir, "job_restart.inp"),
		[]string{"r2SCAN-3c", "Opt", "MORead", "%moinp \"job.gbw\""})
	// Same job: the transient path must not invent keywords beyond the
	// wavefunction restart.
	if strings.Contains(text, "SlowConv") || strings.Contains(text, "UKS") {
		t.Errorf("transient regeneration changed the chemistry:\n%s", text)
	}
}

// TestRestartCmdMemoryCapRefuses: when the machine's RAM already caps the
// request, restart must say so instead of emitting an impossible value.
func TestRestartCmdMemoryCapRefuses(t *testing.T) {
	pinRestartRAM(t, 4096) // 75% of 4 GB < the input's 4000 MB %maxcore
	outPath, dir := stageRestartRun(t, "orca6_out_of_memory.out", restartTestInp)
	if code := RestartCmd([]string{outPath}); code != restartExitNeedsHuman {
		t.Fatalf("exit code = %d, want %d", code, restartExitNeedsHuman)
	}
	if _, err := os.Stat(filepath.Join(dir, "job_restart.inp")); err == nil {
		t.Fatal("no input should be written when the RAM caps the request")
	}
}

// TestRestartCmdIdempotence: restarting a restart escalates the SCF fix
// (stage 2) instead of stacking duplicate keywords.
func TestRestartCmdIdempotence(t *testing.T) {
	outPath, dir := stageRestartRun(t, "orca6_scf_not_converged.out", restartTestInp)
	if code := RestartCmd([]string{outPath}); code != 0 {
		t.Fatalf("first restart: exit %d", code)
	}
	stage1 := filepath.Join(dir, "job_restart.inp")
	requireGeneratedInput(t, stage1, []string{"SlowConv"})

	// The restart also fails the same way: same output, new stem.
	src, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatal(err)
	}
	secondOut := filepath.Join(dir, "job_restart.out")
	if err := os.WriteFile(secondOut, src, 0o644); err != nil {
		t.Fatal(err)
	}
	if code := RestartCmd([]string{secondOut}); code != 0 {
		t.Fatalf("second restart: exit %d", code)
	}
	text := requireGeneratedInput(t, filepath.Join(dir, "job_restart_restart.inp"),
		[]string{"VerySlowConv", "MaxIter 1000", "stage 2"})
	bang := ""
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "! ") {
			bang = line
			break
		}
	}
	if n := strings.Count(strings.ToUpper(bang), "SLOWCONV"); n != 1 {
		t.Errorf("SlowConv-family appears %d times on the keyword line %q", n, bang)
	}
	if strings.Count(text, "%scf") != 1 {
		t.Errorf("%%scf blocks stacked:\n%s", text)
	}
}

// TestRestartCmdDryRunShowsDiff: --dry-run prints the change as a diff
// against the parent input and writes nothing.
func TestRestartCmdDryRunShowsDiff(t *testing.T) {
	outPath, dir := stageRestartRun(t, "orca6_scf_not_converged.out", restartTestInp)

	old := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w
	code := RestartCmd([]string{"-dry-run", outPath})
	os.Stdout = old
	if cerr := w.Close(); cerr != nil {
		t.Fatalf("close pipe: %v", cerr)
	}
	var out strings.Builder
	buf := make([]byte, 64*1024)
	for {
		n, rerr := r.Read(buf)
		out.Write(buf[:n])
		if rerr != nil {
			break
		}
	}
	if cerr := r.Close(); cerr != nil {
		t.Fatalf("close pipe reader: %v", cerr)
	}

	if code != 0 {
		t.Fatalf("exit code = %d, want 0", code)
	}
	if _, err := os.Stat(filepath.Join(dir, "job_restart.inp")); err == nil {
		t.Fatal("--dry-run must not write the input")
	}
	diff := out.String()
	if !strings.Contains(diff, "- ! r2SCAN-3c Opt") || !strings.Contains(diff, "SlowConv") {
		t.Errorf("diff does not show the keyword change:\n%s", diff)
	}
	if !strings.Contains(diff, "+ %scf") {
		t.Errorf("diff does not show the added %%scf block:\n%s", diff)
	}
}
