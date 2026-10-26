package runner

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/nkls-ai/dftstream/internal/tracker"
)

// ORCA is a launcher: the driver process forks orca_gtoint_mpi,
// orca_scfgrad_mpi and friends, and those children are where the CPU
// actually goes. exec.CommandContext's default cancel kills only the
// process it started, so a ^C used to leave the whole MPI fan-out running
// on the node with nothing left to reap it — on a shared cluster that is
// a node full of orphans burning cores until someone notices.
//
// The fake below reproduces that shape: a driver that spawns a
// long-sleeping grandchild, records its pid, and then waits.
const forkingOrcaScript = `#!/bin/sh
sleep 300 &
echo $! > "$PWD/child.pid"
echo "Program Version 6.1.0"
sleep 300
`

func pidAlive(pid int) bool {
	// Signal 0 probes for existence without delivering anything.
	return syscall.Kill(pid, 0) == nil
}

func TestCancelKillsTheWholeOrcaProcessTree(t *testing.T) {
	dir := t.TempDir()
	input := filepath.Join(dir, "h2.inp")
	if err := os.WriteFile(input, []byte("! SP\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	orca := filepath.Join(dir, "orca")
	if err := os.WriteFile(orca, []byte(forkingOrcaScript), 0o755); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		//nolint:errcheck — the run is cancelled on purpose; the error is expected
		_, _ = Run(ctx, Options{
			OrcaPath:       orca,
			InputPath:      input,
			ExperimentName: "exp",
			RunName:        "run",
			SysInterval:    time.Hour,
			ArtifactLevel:  0, // LevelNone: no postproc, no uploads
			Tracker:        &recordingTracker{},
			Stdout:         io.Discard,
			Stderr:         io.Discard,
		})
	}()

	// Wait for the grandchild to exist.
	pidFile := filepath.Join(dir, "child.pid")
	var childPid int
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); {
		b, err := os.ReadFile(pidFile)
		if err == nil {
			if n, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil && n > 0 {
				childPid = n
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	if childPid == 0 {
		cancel()
		<-done
		t.Fatal("fake ORCA never reported a child pid")
	}

	cancel()
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("Run did not return after the context was cancelled")
	}

	// Give the signal a moment to land on the group.
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); {
		if !pidAlive(childPid) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	// Do not leave the orphan behind for the rest of the suite.
	t.Cleanup(func() {
		//nolint:errcheck — best-effort reap of the process this test leaked
		_ = syscall.Kill(childPid, syscall.SIGKILL)
	})
	t.Fatalf("ORCA's child pid %d survived cancellation — the process tree was orphaned", childPid)
}

var _ tracker.Tracker = (*recordingTracker)(nil)
