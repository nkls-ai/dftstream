package submit

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The generated sbatch script interpolates the input's basename in three
// places: the scratch path, the orca command, and the redirect target.
// All three used to take the name raw, so anything the shell reads as
// syntax — a space above all — reached the shell as syntax.
//
// A space is not an edge case. "benzene opt.inp" produced
//
//	TMP=/scratch/benzene opt/$SLURM_JOB_ID
//	orca benzene opt.inp > benzene opt.out
//
// where the first line is a one-off assignment in front of the command
// `opt/$SLURM_JOB_ID` (leaving TMP empty for the rest of the script, so
// the job never reaches scratch and cleanup copies nothing back), and the
// second hands ORCA two arguments. A name carrying `$(...)` or a backtick
// went further and executed.

// scriptFor plans a single job for one input basename and returns its
// script. When stub is non-empty the cluster's dftstream binary is
// pointed at it, so the generated command line can be executed for real.
func scriptFor(t *testing.T, name, stub string) string {
	t.Helper()
	req := testRequest(t, map[string]string{name: realInput}, "ma1-tbu.xyz")
	if stub != "" {
		req.Cluster.DFTStreamBinary = stub
	}
	jobs, err := Plan(req)
	if err != nil {
		t.Fatalf("Plan(%q): %v", name, err)
	}
	if len(jobs) != 1 {
		t.Fatalf("Plan(%q): got %d jobs, want 1", name, len(jobs))
	}
	return jobs[0].Script
}

// echoArgsStub writes an executable that prints each argument on its own
// line, so a generated command can be run and its argv inspected.
func echoArgsStub(t *testing.T, dir string) string {
	t.Helper()
	path := filepath.Join(dir, "echoargs")
	if err := os.WriteFile(path, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\"\n"), 0o755); err != nil {
		t.Fatalf("write stub: %v", err)
	}
	return path
}

// lineWithPrefix returns the first script line starting with prefix.
func lineWithPrefix(t *testing.T, script, prefix string) string {
	t.Helper()
	for _, ln := range strings.Split(script, "\n") {
		if strings.HasPrefix(ln, prefix) {
			return ln
		}
	}
	t.Fatalf("no line starting with %q in script:\n%s", prefix, script)
	return ""
}

// bashEval runs snippet under bash and returns its stdout. Skips when
// bash is not installed.
func bashEval(t *testing.T, snippet string) string {
	t.Helper()
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash not available")
	}
	out, err := exec.Command(bash, "-c", snippet).Output()
	if err != nil {
		t.Fatalf("bash -c %q: %v", snippet, err)
	}
	return strings.TrimRight(string(out), "\n")
}

func TestScriptIsValidShellForNamesWithSpaces(t *testing.T) {
	script := scriptFor(t, "benzene opt.inp", "")

	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash not available")
	}
	path := filepath.Join(t.TempDir(), "job.sh")
	if err := os.WriteFile(path, []byte(script), 0o644); err != nil {
		t.Fatalf("write script: %v", err)
	}
	if out, err := exec.Command(bash, "-n", path).CombinedOutput(); err != nil {
		t.Fatalf("generated script is not valid bash: %v\n%s\n---\n%s", err, out, script)
	}

	// TMP must come out as one word holding the whole path, with
	// $SLURM_JOB_ID still expanded.
	tmpLine := lineWithPrefix(t, script, "TMP=")
	got := bashEval(t, "SLURM_JOB_ID=4242\n"+tmpLine+"\nprintf '%s' \"$TMP\"")
	if !strings.HasSuffix(got, "/benzene opt/4242") {
		t.Errorf("TMP evaluated to %q, want a path ending in %q\n  line: %s",
			got, "/benzene opt/4242", tmpLine)
	}
}

func TestScriptDoesNotExecuteNamesWithShellMetacharacters(t *testing.T) {
	// Legal POSIX filenames that are also shell syntax. `$(...)` and a
	// backtick substitute a command; `;` ends one.
	for _, name := range []string{
		"$(touch pwned).inp",
		"`touch pwned`.inp",
		"a;touch pwned;b.inp",
		"a|touch pwned|b.inp",
		"a&touch pwned&b.inp",
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			script := scriptFor(t, name, echoArgsStub(t, dir))
			stem := strings.TrimSuffix(name, ".inp")

			// Run the scratch-path line in a sandbox. If quoting is wrong,
			// `touch pwned` runs and the canary appears.
			tmpVal := bashEval(t, "cd "+shQuote(dir)+"\nSLURM_JOB_ID=1\n"+
				lineWithPrefix(t, script, "TMP=")+"\nprintf '%s' \"$TMP\"")
			if _, err := os.Stat(filepath.Join(dir, "pwned")); err == nil {
				t.Fatalf("scratch-path line executed the filename %q as a command", name)
			}
			if !strings.HasSuffix(tmpVal, "/"+stem+"/1") {
				t.Errorf("TMP = %q, want a path ending in %q", tmpVal, "/"+stem+"/1")
			}

			// Run the orca command line for real against the arg-echoing
			// stub: the input must arrive as exactly one intact argument.
			var orcaLine string
			for _, ln := range strings.Split(script, "\n") {
				if strings.Contains(ln, " > ") && strings.Contains(ln, ".out") {
					orcaLine = ln
				}
			}
			if orcaLine == "" {
				t.Fatalf("no orca command line in script:\n%s", script)
			}
			out := bashEval(t, "cd "+shQuote(dir)+"\n"+orcaLine+"\ncat "+shQuote(stem+".out"))
			if _, err := os.Stat(filepath.Join(dir, "pwned")); err == nil {
				t.Fatalf("orca command line executed the filename %q as a command", name)
			}
			args := strings.Split(out, "\n")
			found := false
			for _, a := range args {
				if a == name {
					found = true
				}
			}
			if !found {
				t.Errorf("orca did not receive %q as a single intact argument; got %q", name, args)
			}
		})
	}
}

// A line break cannot be quoted out of `#SBATCH --job-name=<name>`: the
// second line is simply another directive, and past the header it is a
// shell line. Refuse the name instead of emitting a script that means
// something other than what it says.
func TestPlanRefusesNamesWithLineBreaks(t *testing.T) {
	for _, name := range []string{"a\nb.inp", "a\rb.inp", "a\x00b.inp", "a\x1bb.inp"} {
		if err := validateInputName(name, false); err == nil {
			t.Errorf("validateInputName(%q) = nil, want an error", name)
		}
	}
	for _, name := range []string{"opt-freq_x.inp", "benzene opt.inp", "a-b_c.2.inp"} {
		if err := validateInputName(name, false); err != nil {
			t.Errorf("validateInputName(%q) = %v, want nil", name, err)
		}
	}
}

// input_list.txt is whitespace-separated and read back with `read -r`,
// so an array cannot carry a name containing a space however it is
// quoted. Single-job submission of the same name is fine.
func TestArrayRefusesNamesWithSpaces(t *testing.T) {
	if err := validateInputName("benzene opt.inp", true); err == nil {
		t.Error("validateInputName(space, array) = nil, want an error")
	}
	if err := validateInputName("benzene opt.inp", false); err != nil {
		t.Errorf("validateInputName(space, single) = %v, want nil", err)
	}

	req := testRequest(t, map[string]string{"benzene opt.inp": realInput}, "ma1-tbu.xyz")
	req.Array = true
	req.ArrayName = "batch"
	if _, err := Plan(req); err == nil {
		t.Error("Plan with -array and a spaced input name succeeded, want an error")
	}
}

// Cluster config values (clean/copy-back globs, module names) come from
// the operator, not the user — but they still must never reach the shell
// as syntax. A glob pattern carrying `$(...)` used to be wrapped in bare
// double quotes, where command substitution stays live; module names were
// emitted raw.
func TestHostileCleanGlobsAreNotExecuted(t *testing.T) {
	dir := t.TempDir()
	hostile := "$(touch pwned).tmp*"
	req := testRequest(t, map[string]string{"x.inp": realInput}, "ma1-tbu.xyz")
	req.Cluster.Scratch.CleanGlobs = []string{hostile, "*.tmp"}
	jobs, err := Plan(req)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	script := jobs[0].Script

	// Run the clean_scratch call line against a stub that echoes its argv:
	// nothing may execute, and each pattern must arrive as one literal word.
	line := lineWithPrefix(t, script, "    clean_scratch ")
	out := bashEval(t, "cd "+shQuote(dir)+"\nclean_scratch() { printf '%s\\n' \"$@\"; }\n"+line)
	if _, err := os.Stat(filepath.Join(dir, "pwned")); err == nil {
		t.Fatalf("clean_scratch call line executed the glob %q as a command", hostile)
	}
	args := strings.Split(out, "\n")
	if len(args) != 2 || args[0] != hostile || args[1] != "*.tmp" {
		t.Errorf("clean_scratch received %q, want [%q %q]", args, hostile, "*.tmp")
	}
}

func TestHostileCopyBackGlobsAreNotExecuted(t *testing.T) {
	dir := t.TempDir()
	hostile := "`touch pwned`*.out"
	req := testRequest(t, map[string]string{"x.inp": realInput}, "ma1-tbu.xyz")
	req.Cluster.Scratch.CopyBackGlobs = []string{hostile}
	req.Profile.CopyBackGlobs = nil
	jobs, err := Plan(req)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	line := lineWithPrefix(t, jobs[0].Script, "    copy_back ")
	out := bashEval(t, "cd "+shQuote(dir)+"\ncopy_back() { printf '%s\\n' \"$@\"; }\n"+line)
	if _, err := os.Stat(filepath.Join(dir, "pwned")); err == nil {
		t.Fatalf("copy_back call line executed the glob %q as a command", hostile)
	}
	found := false
	for _, a := range strings.Split(out, "\n") {
		if a == hostile {
			found = true
		}
	}
	if !found {
		t.Errorf("copy_back did not receive %q as a single intact argument; got %q", hostile, out)
	}
}

func TestHostileModuleNamesAreNotExecuted(t *testing.T) {
	dir := t.TempDir()
	// `>pwned` needs no space: broken quoting would run the empty command
	// with a redirection and create the canary. A hostile name containing
	// spaces is split into separate (still-quoted, harmless) words by the
	// multi-module field split, so it cannot arrive as one argument.
	hostile := "orca/`>pwned`"
	req := testRequest(t, map[string]string{"x.inp": realInput}, "ma1-tbu.xyz")
	req.Cluster.Modules = []string{"chem orca/6.0.1", hostile, "$(>pwned)/6"}
	jobs, err := Plan(req)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	script := jobs[0].Script

	// Every `module load` line runs against a stub that echoes its argv.
	var snippet strings.Builder
	snippet.WriteString("cd " + shQuote(dir) + "\nmodule() { printf '%s\\n' \"$@\"; }\n")
	n := 0
	for _, ln := range strings.Split(script, "\n") {
		if strings.HasPrefix(ln, "module load ") {
			snippet.WriteString(ln + "\n")
			n++
		}
	}
	if n != 3 {
		t.Fatalf("got %d module load lines, want 3:\n%s", n, script)
	}
	out := bashEval(t, snippet.String())
	if _, err := os.Stat(filepath.Join(dir, "pwned")); err == nil {
		t.Fatalf("module load line executed the module name %q as a command", hostile)
	}
	want := []string{"load", "chem", "orca/6.0.1", "load", hostile, "load", "$(>pwned)/6"}
	got := strings.Split(out, "\n")
	if strings.Join(got, "\x00") != strings.Join(want, "\x00") {
		t.Errorf("module argv = %q, want %q", got, want)
	}
}

func TestArrayNameIsValidated(t *testing.T) {
	req := testRequest(t, map[string]string{"opt-freq_x.inp": realInput}, "ma1-tbu.xyz")
	req.Array = true
	req.ArrayName = "batch\n#SBATCH --partition=root"
	if _, err := Plan(req); err == nil {
		t.Error("Plan accepted an -array-name containing a line break")
	}
}
