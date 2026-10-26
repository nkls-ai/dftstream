package postproc

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeRunner records every invocation and simulates orca_plot by writing
// the cube files the interactive script asks for — without executing
// anything.
type fakeRunner struct {
	calls []fakeCall
	err   error
}

type fakeCall struct {
	dir   string
	bin   string
	args  []string
	stdin string
}

func (f *fakeRunner) Run(_ context.Context, dir, bin string, args []string, stdin string) (string, error) {
	f.calls = append(f.calls, fakeCall{dir: dir, bin: bin, args: args, stdin: stdin})
	if f.err != nil {
		return "simulated tool failure output", f.err
	}
	// The orca_plot script is pairs of "2\n<mo>\n11\n" plus a trailing "12\n";
	// write one cube per requested MO, like the real tool would.
	stem := strings.TrimSuffix(args[0], ".gbw")
	lines := strings.Split(stdin, "\n")
	for i := 0; i+1 < len(lines); i++ {
		if lines[i] == "2" {
			name := fmt.Sprintf("%s.mo%sa.cube", stem, lines[i+1])
			if err := os.WriteFile(filepath.Join(dir, name), []byte("cube"), 0o644); err != nil {
				return "", err
			}
		}
	}
	return "", nil
}

func TestGenerateOrbitalCubesWithFakeRunner(t *testing.T) {
	orcaDir := t.TempDir()
	workDir := t.TempDir()
	// Stat checks in GenerateOrbitalCubes still need the files to exist.
	if err := os.WriteFile(filepath.Join(orcaDir, "orca_plot"), []byte("stub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workDir, "job.gbw"), []byte("gbw"), 0o644); err != nil {
		t.Fatal(err)
	}

	fake := &fakeRunner{}
	cubes, err := Toolchain{Exec: fake}.GenerateOrbitalCubes(
		context.Background(), orcaDir, workDir, "job", sampleOrbBlock, time.Second)
	if err != nil {
		t.Fatalf("GenerateOrbitalCubes: %v", err)
	}

	if len(fake.calls) != 1 {
		t.Fatalf("runner calls = %d, want 1", len(fake.calls))
	}
	call := fake.calls[0]
	if filepath.Base(call.bin) != "orca_plot" {
		t.Errorf("bin = %q, want orca_plot", call.bin)
	}
	if len(call.args) != 2 || call.args[0] != "job.gbw" || call.args[1] != "-i" {
		t.Errorf("args = %v, want [job.gbw -i]", call.args)
	}
	// The tool must run in a scratch dir, never the user's workDir.
	if call.dir == workDir {
		t.Error("tool ran in workDir — must run in a scratch copy")
	}
	// HOMO=4/LUMO=5 for sampleOrbBlock.
	if !strings.Contains(call.stdin, "2\n4\n11\n2\n5\n11\n") {
		t.Errorf("stdin script = %q, want HOMO 4 + LUMO 5 requests", call.stdin)
	}
	if len(cubes) != 2 {
		t.Fatalf("cubes = %d, want 2 (HOMO+LUMO)", len(cubes))
	}
}

func TestGenerateOrbitalCubesSurfacesRunnerError(t *testing.T) {
	orcaDir := t.TempDir()
	workDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(orcaDir, "orca_plot"), []byte("stub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workDir, "job.gbw"), []byte("gbw"), 0o644); err != nil {
		t.Fatal(err)
	}

	fake := &fakeRunner{err: fmt.Errorf("boom")}
	_, err := Toolchain{Exec: fake}.GenerateOrbitalCubes(
		context.Background(), orcaDir, workDir, "job", sampleOrbBlock, time.Second)
	if err == nil {
		t.Fatal("expected error from failing runner")
	}
	if !strings.Contains(err.Error(), "boom") || !strings.Contains(err.Error(), "simulated tool failure output") {
		t.Fatalf("error should carry cause and tool output, got: %v", err)
	}
}
