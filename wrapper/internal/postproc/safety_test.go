package postproc

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// fakePlotScript stands in for orca_plot. It does the dangerous thing the
// real tool does — re-saves (mutates) the .gbw it is pointed at — and writes
// a cube file per MO index it reads from the interactive stdin script. If the
// wrapper ran it against the original .gbw, that original would be mutated.
const fakePlotScript = `#!/bin/sh
gbw="$1"
stem="${gbw%.gbw}"
# Simulate orca_plot rewriting the gbw it opened.
printf 'MUTATED-BY-ORCA_PLOT' >> "$gbw"
prev=""
while IFS= read -r line; do
	if [ "$prev" = "2" ]; then
		echo "cube for MO $line" > "${stem}.mo${line}a.cube"
	fi
	prev="$line"
done
`

// fakePltvibScript stands in for orca_pltvib: mutates the .hess it is given
// and writes a displacement xyz per requested mode index.
const fakePltvibScript = `#!/bin/sh
hess="$1"
stem="${hess%.hess}"
printf 'MUTATED-BY-ORCA_PLTVIB' >> "$hess"
shift
for m in "$@"; do
	out=$(printf '%s.v%03d.xyz' "$stem" "$m")
	echo "displacement for mode $m" > "$out"
done
`

func writeExec(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func TestGenerateOrbitalCubesNeverTouchesOriginalGBW(t *testing.T) {
	orcaDir := t.TempDir()
	workDir := t.TempDir()
	writeExec(t, filepath.Join(orcaDir, "orca_plot"), fakePlotScript)

	// The pristine wavefunction file ORCA produced.
	original := []byte("ORCA GBW BINARY PAYLOAD \x00\x01\x02 do-not-touch")
	gbwPath := filepath.Join(workDir, "job.gbw")
	if err := os.WriteFile(gbwPath, original, 0o644); err != nil {
		t.Fatal(err)
	}

	cubes, err := Toolchain{}.GenerateOrbitalCubes(context.Background(), orcaDir, workDir, "job", sampleOrbBlock, 10*time.Second)
	if err != nil {
		t.Fatalf("GenerateOrbitalCubes: %v", err)
	}

	// The original gbw must be byte-for-byte unchanged.
	after, err := os.ReadFile(gbwPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(original, after) {
		t.Fatalf("original gbw was modified: %q", after)
	}

	// HOMO=4, LUMO=5 for sampleOrbBlock — cubes must be harvested into workDir.
	if len(cubes) != 2 {
		t.Fatalf("cubes = %d, want 2", len(cubes))
	}
	for _, name := range []string{"job.mo4a.cube", "job.mo5a.cube"} {
		if _, err := os.Stat(filepath.Join(workDir, name)); err != nil {
			t.Fatalf("expected harvested cube %s in workDir: %v", name, err)
		}
	}

	// No scratch copy of the gbw should leak into the user's workDir.
	if entries, _ := filepath.Glob(filepath.Join(workDir, "*.gbw")); len(entries) != 1 {
		t.Fatalf("workDir .gbw files = %v, want only the original", entries)
	}
}

func TestGenerateImagVibTrjsNeverTouchesOriginalHess(t *testing.T) {
	orcaDir := t.TempDir()
	workDir := t.TempDir()
	writeExec(t, filepath.Join(orcaDir, "orca_pltvib"), fakePltvibScript)

	original := []byte("ORCA HESS PAYLOAD \x00 keep-me-intact")
	hessPath := filepath.Join(workDir, "job.hess")
	if err := os.WriteFile(hessPath, original, 0o644); err != nil {
		t.Fatal(err)
	}

	vibs, err := Toolchain{}.GenerateImagVibTrjs(context.Background(), orcaDir, workDir, "job",
		[]ImagMode{{Index: 6, Wavenumber: -123.4}}, 10*time.Second)
	if err != nil {
		t.Fatalf("GenerateImagVibTrjs: %v", err)
	}

	after, err := os.ReadFile(hessPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(original, after) {
		t.Fatalf("original hess was modified: %q", after)
	}

	if len(vibs) != 1 {
		t.Fatalf("vibs = %d, want 1", len(vibs))
	}
	if _, err := os.Stat(filepath.Join(workDir, "job.v006.xyz")); err != nil {
		t.Fatalf("expected harvested vib xyz in workDir: %v", err)
	}
}

func TestGeneratePerCycleRunsOnSnapshotsNotWorkDir(t *testing.T) {
	orcaDir := t.TempDir()
	workDir := t.TempDir()
	snapDir := t.TempDir()
	writeExec(t, filepath.Join(orcaDir, "orca_plot"), fakePlotScript)

	// Snapshots live in snapDir (dftstream-made copies), never in workDir.
	for _, c := range []int{1, 2} {
		snap := filepath.Join(snapDir, "job.c00"+string(rune('0'+c))+".gbw")
		if err := os.WriteFile(snap, []byte("snapshot copy"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	cubes, err := Toolchain{}.GeneratePerCycleOrbitalCubes(context.Background(), orcaDir, snapDir, workDir, "job",
		sampleOrbBlock, []int{1, 2}, 10*time.Second)
	if err != nil {
		t.Fatalf("GeneratePerCycleOrbitalCubes: %v", err)
	}
	// 2 cycles x 2 orbitals = 4 cubes, harvested into workDir.
	if len(cubes) != 4 {
		t.Fatalf("cubes = %d, want 4", len(cubes))
	}
	// workDir must contain no .gbw at all — snapshots stayed in snapDir.
	if entries, _ := filepath.Glob(filepath.Join(workDir, "*.gbw")); len(entries) != 0 {
		t.Fatalf("workDir leaked .gbw files: %v", entries)
	}
}
