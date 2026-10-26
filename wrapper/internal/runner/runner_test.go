package runner

import (
	"context"
	"io"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nkls-ai/dftstream/internal/levels"
	"github.com/nkls-ai/dftstream/internal/tracker"
)

func TestRunTracksParsedOrcaOutput(t *testing.T) {
	dir := t.TempDir()
	input := filepath.Join(dir, "h2.inp")
	if err := os.WriteFile(input, []byte("! OPT FREQ\n%pal nprocs 2 end\n%maxcore 1000\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	orca := filepath.Join(dir, "orca")
	if err := os.WriteFile(orca, []byte(fakeOrcaScript), 0o755); err != nil {
		t.Fatal(err)
	}

	rec := &recordingTracker{}
	res, err := Run(context.Background(), Options{
		OrcaPath:       orca,
		InputPath:      input,
		ExperimentName: "exp",
		RunName:        "run",
		SysInterval:    time.Hour,
		Tracker:        rec,
		Stdout:         io.Discard,
		Stderr:         io.Discard,
	})
	if err != nil {
		t.Fatalf("Run returned error: %v", err)
	}
	if res.ExitCode != 0 {
		t.Fatalf("exit code = %d, want 0", res.ExitCode)
	}

	if len(rec.created) != 1 {
		t.Fatalf("created runs = %d, want 1", len(rec.created))
	}
	created := rec.created[0]
	if created.JobType != "OPT_FREQ" || created.NProcs != 2 || created.MaxCoreMB != 1000 {
		t.Fatalf("unexpected run metadata: %+v", created)
	}
	if len(rec.geometries) != 1 {
		t.Fatalf("geometries = %d, want 1", len(rec.geometries))
	}
	if len(rec.frequencies) != 2 || !rec.frequencies[1].Imaginary {
		t.Fatalf("frequencies = %+v, want two with second imaginary", rec.frequencies)
	}

	var scfMetrics int
	for _, m := range rec.metrics {
		if m.Key == "scf_iter_energy" {
			scfMetrics++
		}
	}
	if scfMetrics != 2 {
		t.Fatalf("SCF metrics = %d, want 2", scfMetrics)
	}

	last := rec.statuses[len(rec.statuses)-1]
	if last.Status != tracker.StatusFinished || last.ExitCode == nil || *last.ExitCode != 0 {
		t.Fatalf("final status = %+v, want finished exit 0", last)
	}
	if last.LastEnergy == nil || math.Abs(*last.LastEnergy-(-2.5)) > 1e-12 {
		t.Fatalf("last energy = %v, want -2.5", last.LastEnergy)
	}
}

func TestRunExecutesOrcaInInputDir(t *testing.T) {
	dir := t.TempDir()
	input := filepath.Join(dir, "h2.inp")
	if err := os.WriteFile(input, []byte("! HF DEF2-SVP\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// This fake ORCA records its own working directory by writing a file via
	// a relative path — the file lands wherever cmd.Dir put the process.
	orca := filepath.Join(dir, "orca")
	script := "#!/bin/sh\npwd > ran_in.txt\n" +
		"echo 'Program Version 6.1.0'\n" +
		"echo 'FINAL SINGLE POINT ENERGY      -1.0'\n" +
		"echo 'TOTAL RUN TIME: 0 days 0 hours 0 minutes 1 seconds 0 msec'\n" +
		"echo 'ORCA TERMINATED NORMALLY'\n"
	if err := os.WriteFile(orca, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	res, err := Run(context.Background(), Options{
		OrcaPath:       orca,
		InputPath:      input,
		ExperimentName: "exp",
		RunName:        "run",
		SysInterval:    time.Hour,
		Tracker:        &recordingTracker{},
		Stdout:         io.Discard,
		Stderr:         io.Discard,
	})
	if err != nil {
		t.Fatalf("Run returned error: %v", err)
	}
	if res.ExitCode != 0 {
		t.Fatalf("exit code = %d, want 0", res.ExitCode)
	}

	// ORCA's relative-path output must land in the input file's directory,
	// not in the test process's cwd — proving cmd.Dir was pinned there.
	marker := filepath.Join(dir, "ran_in.txt")
	got, err := os.ReadFile(marker)
	if err != nil {
		t.Fatalf("expected ORCA to write into input dir, but %s missing: %v", marker, err)
	}
	wantDir, _ := filepath.EvalSymlinks(dir)
	gotDir, _ := filepath.EvalSymlinks(strings.TrimSpace(string(got)))
	if gotDir != wantDir {
		t.Fatalf("ORCA ran in %q, want input dir %q", gotDir, wantDir)
	}
}

func TestIngestReportsAbnormalOutput(t *testing.T) {
	dir := t.TempDir()
	input := filepath.Join(dir, "h2.inp")
	output := filepath.Join(dir, "h2.out")
	if err := os.WriteFile(input, []byte("! HF DEF2-SVP\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(output, []byte("FINAL SINGLE POINT ENERGY      -1.0\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	rec := &recordingTracker{}
	res, err := Ingest(context.Background(), IngestOptions{
		RunDir:         dir,
		InputPath:      input,
		OutputPath:     output,
		ExperimentName: "exp",
		RunName:        "run",
		Tracker:        rec,
	})
	if err == nil {
		t.Fatal("Ingest returned nil error for abnormal output")
	}
	if res.ExitCode == 0 {
		t.Fatal("Ingest exit code = 0, want nonzero")
	}
	last := rec.statuses[len(rec.statuses)-1]
	if last.Status != tracker.StatusFailed {
		t.Fatalf("final status = %s, want failed", last.Status)
	}
}

const fakeOrcaScript = `#!/bin/sh
cat <<'EOF'
Program Version 6.1.0
GEOMETRY OPTIMIZATION CYCLE   1
CARTESIAN COORDINATES (ANGSTROEM)
---------------------------------
C      0.000000   0.000000   0.000000
H      0.000000   0.000000   1.000000

----------------------------------------D-I-I-S--------------------------------------------
Iteration    Energy (Eh)           Delta-E    RMSDP     MaxDP     DIISErr   Damp  Time(sec)
-------------------------------------------------------------------------------------------
    1    -2.0000000000000000     0.00e+00  3.77e-03  7.50e-02  1.45e-01  0.700   2.1
Warning: Small HOMO/LUMO gap - skipping pre-diagonalization
    2    -2.5000000000000000    -5.00e-01  2.80e-03  3.73e-02  4.69e-02  0.700   1.8
               *****************************************************
               *                     SUCCESS                       *
SCF CONVERGED AFTER   2 CYCLES
Total Energy       :         -2.50000000 Eh
FINAL SINGLE POINT ENERGY      -2.500000000000
VIBRATIONAL FREQUENCIES
  0:       0.00 cm**-1
  1:     -65.98 cm**-1  ***imaginary mode***
END FREQ
TOTAL RUN TIME: 0 days 0 hours 0 minutes 1 seconds 5 msec
ORCA TERMINATED NORMALLY
EOF
`

type recordingTracker struct {
	mu          sync.Mutex
	created     []tracker.RunCreate
	statuses    []tracker.StatusUpdate
	events      []tracker.Event
	metrics     []tracker.Metric
	geometries  []string
	frequencies []tracker.Frequency
}

func (r *recordingTracker) EnsureExperiment(context.Context, string, string) (tracker.ExperimentID, error) {
	return "exp-id", nil
}

func (r *recordingTracker) EnsureBatch(context.Context, tracker.ExperimentID, string, levels.ArtifactLevel) (tracker.BatchID, error) {
	return "batch-id", nil
}

func (r *recordingTracker) CreateRun(_ context.Context, c tracker.RunCreate) (tracker.RunID, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.created = append(r.created, c)
	return "run-id", nil
}

func (r *recordingTracker) FindRunByName(context.Context, tracker.ExperimentID, string) (tracker.RunID, error) {
	return "", nil
}

func (r *recordingTracker) UpdateRunStatus(_ context.Context, _ tracker.RunID, s tracker.StatusUpdate) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.statuses = append(r.statuses, s)
	return nil
}

func (r *recordingTracker) AppendEvent(_ context.Context, _ tracker.RunID, e tracker.Event) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, e)
	return nil
}

func (r *recordingTracker) AppendMetric(_ context.Context, _ tracker.RunID, m tracker.Metric) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.metrics = append(r.metrics, m)
	return nil
}

func (r *recordingTracker) AppendGeometry(_ context.Context, _ tracker.RunID, _ int, xyz string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.geometries = append(r.geometries, xyz)
	return nil
}

func (r *recordingTracker) SetFrequencies(_ context.Context, _ tracker.RunID, f []tracker.Frequency) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.frequencies = append([]tracker.Frequency(nil), f...)
	return nil
}

func (r *recordingTracker) AppendSysSample(context.Context, tracker.RunID, tracker.SysSample) error {
	return nil
}

func (r *recordingTracker) SetArtifacts(context.Context, tracker.RunID, []tracker.Artifact) error {
	return nil
}

func (r *recordingTracker) AppendArtifacts(context.Context, tracker.RunID, []tracker.Artifact) error {
	return nil
}

func (r *recordingTracker) UpsertArtifacts(context.Context, tracker.RunID, []tracker.Artifact) error {
	return nil
}

func (r *recordingTracker) AppendLogs(context.Context, tracker.RunID, []tracker.LogEntry) error {
	return nil
}
func (r *recordingTracker) SetExcitedStates(context.Context, tracker.RunID, []tracker.ExcitedState) error {
	return nil
}
func (r *recordingTracker) SetNMRShields(context.Context, tracker.RunID, []tracker.NMRShield) error {
	return nil
}

func (r *recordingTracker) Close(context.Context) error { return nil }
