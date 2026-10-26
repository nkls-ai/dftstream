//go:build !unix

package runner

import (
	"os/exec"
	"time"
)

// Non-unix platforms have no process groups in the POSIX sense, so the
// tree-wide signalling degrades to exec's own single-process cancel.
// ORCA does not ship for these targets; the stubs exist so the runner
// stays buildable everywhere.

const orcaShutdownGrace = 10 * time.Second

func configureCancellation(cmd *exec.Cmd) {
	// Still bound the wait on the output pipes, so a surviving child
	// holding stdout cannot turn a cancellation into a hang.
	cmd.WaitDelay = orcaShutdownGrace
}

func reapProcessTree(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	return cmd.Process.Kill()
}
