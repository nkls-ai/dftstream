//go:build unix

package runner

import (
	"os/exec"
	"syscall"
	"time"
)

// ORCA is a launcher, not a solver: the process we start forks
// orca_gtoint_mpi, orca_scfgrad_mpi and the rest, and those children are
// where the calculation actually runs. Two consequences follow, and both
// used to bite on ^C.
//
//   - exec.CommandContext's default cancel kills only the process it
//     started. The MPI children survived and kept running on the node
//     with nothing left to reap them.
//   - Those children inherit ORCA's stdout pipe. Go's cmd.Wait waits for
//     the pipe to reach EOF, so as long as one orphan held it open Wait
//     never returned and `dftstream run` hung after the user had already
//     pressed ^C.
//
// Putting ORCA in its own process group lets us signal the whole tree at
// once, which fixes both.

// orcaShutdownGrace is how long ORCA gets to wind down after a ^C before
// the wrapper stops waiting on its output pipes and SIGKILLs whatever is
// left of the process tree. Long enough for ORCA to flush and close the
// files it is mid-write on, short enough that a user who pressed ^C gets
// their shell back.
const orcaShutdownGrace = 10 * time.Second

// configureCancellation puts the child in its own process group and wires
// cancellation to signal that whole group, with a bounded wait on the
// output pipes afterwards. SIGTERM first, so ORCA can close its files.
func configureCancellation(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
	cmd.Cancel = func() error { return signalProcessTree(cmd, syscall.SIGTERM) }
	// After the context is done, bound how long Wait will sit on the I/O
	// pipes: a worker that ignores SIGTERM must not turn ^C into a hang.
	// Wait force-closes the pipes when this elapses and returns.
	cmd.WaitDelay = orcaShutdownGrace
}

// signalProcessTree sends sig to every process in the child's group. A
// negative pid is the POSIX spelling for "the group with this id".
func signalProcessTree(cmd *exec.Cmd, sig syscall.Signal) error {
	if cmd.Process == nil {
		return nil
	}
	return syscall.Kill(-cmd.Process.Pid, sig)
}

// reapProcessTree is the escalation after a cancelled run: whatever
// ignored the SIGTERM gets a SIGKILL. Called once cmd.Wait has returned,
// so the grace period has already elapsed.
//
// ESRCH ("no such process") is the expected outcome of a clean shutdown —
// the whole group is already gone — and is not an error worth reporting.
func reapProcessTree(cmd *exec.Cmd) error {
	err := signalProcessTree(cmd, syscall.SIGKILL)
	if err == syscall.ESRCH {
		return nil
	}
	return err
}
