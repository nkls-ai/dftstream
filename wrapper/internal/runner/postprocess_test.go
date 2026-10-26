package runner

import (
	"bytes"
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nkls-ai/dftstream/internal/artifacts"
	"github.com/nkls-ai/dftstream/internal/levels"
)

// An overflowed stdout capture holds only the head of ORCA's output, so the
// HOMO index / last frequency block parsed from it would be wrong. The
// orbital and imag-vib steps must be skipped, and say so.
func TestRunPostprocSkipsOutputDrivenStepsOnOverflow(t *testing.T) {
	dir := t.TempDir()
	capw := artifacts.NewCapWriter(16)
	if _, err := capw.Write([]byte(strings.Repeat("x", 64))); err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	runPostproc(context.Background(), Options{
		InputPath:   filepath.Join(dir, "job.inp"),
		OrcaPath:    filepath.Join(dir, "orca"),
		OrbitalMode: levels.OrbitalsFinal,
		Stderr:      &stderr,
	}, capw, "", nil)

	if got := stderr.String(); !strings.Contains(got, "orbital cubes and imag-vib trjs skipped") {
		t.Fatalf("no overflow warning on stderr: %q", got)
	}
}
