package submit

import (
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

// ErrNoScheduler means the submit command itself is not on this machine
// — almost always because the user is on a compute node or a laptop
// rather than a login node.
var ErrNoScheduler = errors.New("scheduler command not found")

// SubmitCommand is the command line that queues a staged job, for
// printing when the user did not ask us to submit.
func SubmitCommand(job Job) string {
	return "sbatch " + job.ScriptPath
}

// Submit queues a staged job and returns the scheduler's reply
// ("Submitted batch job 12345"). It is only ever called when the user
// explicitly asked to submit.
func Submit(job Job) (string, error) {
	bin, err := exec.LookPath("sbatch")
	if err != nil {
		return "", fmt.Errorf("%w: sbatch (are you on a login node?)", ErrNoScheduler)
	}
	cmd := exec.Command(bin, filepath.Base(job.ScriptPath))
	// Submit from the job directory so a relative path in the script or
	// in the user's SLURM defaults resolves the way it does by hand.
	cmd.Dir = job.Dir
	out, err := cmd.CombinedOutput()
	reply := strings.TrimSpace(string(out))
	if err != nil {
		if reply == "" {
			return "", fmt.Errorf("sbatch failed: %w", err)
		}
		return "", fmt.Errorf("sbatch failed: %w: %s", err, reply)
	}
	return reply, nil
}

// submitReplyRe matches sbatch's success line, with or without the
// federated-cluster suffix: "Submitted batch job 12345 [on cluster foo]".
var submitReplyRe = regexp.MustCompile(`Submitted batch job (\d+)`)

// ParseJobID extracts the scheduler job id from an sbatch reply. ok is false
// when the reply carries no id — a site-patched sbatch with rewritten
// output — in which case the caller must skip queue registration rather
// than register garbage.
func ParseJobID(reply string) (string, bool) {
	m := submitReplyRe.FindStringSubmatch(reply)
	if m == nil {
		return "", false
	}
	return m[1], true
}
