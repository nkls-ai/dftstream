package cli

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/nkls-ai/dftstream/internal/cliui"
	"github.com/nkls-ai/dftstream/internal/submit"
	"github.com/nkls-ai/dftstream/internal/tracker"
)

// submittedJob pairs a staged job with the scheduler id sbatch replied with.
type submittedJob struct {
	job   submit.Job
	jobID string
}

// registerBudget bounds the whole best-effort registration pass. Submission
// already succeeded; a down backend may cost seconds of chatter, never the
// submission.
const registerBudget = 20 * time.Second

// registerSubmittedJobs records freshly queued jobs on the tracking backend
// so the UI can show them before any run exists. STRICTLY best-effort: the
// jobs are in the scheduler's hands already, so every failure here is a
// stderr note and never an exit code — the login-node watcher and the run
// itself will backfill what this pass could not. Returns nothing for the
// same reason.
func registerSubmittedJobs(req submit.Request, submitted []submittedJob) {
	if len(submitted) == 0 {
		return
	}
	dsn := resolveTrackerURL("")
	orgID, ct, err := openConvexBackend(backendSpec{
		dsn: dsn,
		// Two attempts, not the full 8-attempt ladder: an offline login node
		// must not stall a successful submission for half a minute.
		maxRetries: 1,
		quiet:      true,
	})
	if errors.Is(err, errNotConvexBackend) {
		// Not a Convex backend (noop:// smoke tests): there is nowhere to
		// register, which is fine and not worth a warning.
		cliui.Hint(os.Stderr, fmt.Sprintf("queue registration skipped (tracker %s)", dsn))
		return
	}
	if err != nil {
		cliui.Warning(os.Stderr, fmt.Sprintf("submitted, but not registered with the backend: %v", err),
			"The queue view will pick the job(s) up when `dftstream queue watch` runs on a login node.")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), registerBudget)
	defer cancel()

	expID, err := ct.EnsureExperiment(ctx, orgID, req.Experiment)
	if err != nil {
		cliui.Warning(os.Stderr, fmt.Sprintf("submitted, but not registered with the backend: %v", err),
			"The jobs still run; tracking starts when they do. Check the tracker URL / `dftstream login` if this persists.")
		return
	}
	for _, s := range submitted {
		reg := tracker.QueuedJobRegistration{
			ExperimentID:   expID,
			Cluster:        req.Cluster.Name,
			Scheduler:      string(req.Cluster.Scheduler),
			SchedulerJobID: s.jobID,
			InputBasename:  registeredName(s.job),
			ArraySpec:      req.ArraySpec(s.job),
			TaskCount:      arrayTaskCount(s.job),
		}
		if _, err := ct.RegisterQueuedJob(ctx, reg); err != nil {
			cliui.Warning(os.Stderr, fmt.Sprintf("%s: submitted as job %s, but not registered with the backend: %v", s.job.Name, s.jobID, err), "")
			continue
		}
		cliui.Hint(os.Stderr, fmt.Sprintf("%s: registered job %s for the queue view", s.job.Name, s.jobID))
	}
	if err := ct.Close(ctx); err != nil {
		// Nothing buffered in the raw tracker; note it and move on.
		fmt.Fprintf(os.Stderr, "[dftstream] note: closing tracker after registration: %v\n", err) //nolint:errcheck — write to stderr is best-effort
	}
}

// registeredName is what the queue row displays: the single job's input
// file, or the array's job name.
func registeredName(job submit.Job) string {
	if !job.Array && len(job.Inputs) == 1 {
		return job.Inputs[0]
	}
	return job.Name
}

func arrayTaskCount(job submit.Job) int {
	if !job.Array {
		return 0
	}
	return len(job.Inputs)
}
