package tracker

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/nkls-ai/dftstream/internal/queue"
)

// Convex function paths of the scheduler-queue module (db/convex/queue.ts).
const (
	fnQueueRegister      = "queue:register"
	fnQueueUpdateStates  = "queue:updateStates"
	fnQueueListActive    = "queue:listActive"
	fnQueueRequestCancel = "queue:requestCancel"
)

// QueuedJobRegistration is what `dftstream submit` reports right after a
// successful sbatch. Scheduler carries the cluster config's scheduler name
// ("slurm"); the backend validates it against its closed union.
type QueuedJobRegistration struct {
	ExperimentID   ExperimentID
	Cluster        string
	Scheduler      string
	SchedulerJobID string
	InputBasename  string
	ArraySpec      string // empty for single jobs
	TaskCount      int    // 0 for single jobs
}

// QueuedJob is one backend queue row as the watcher sees it.
type QueuedJob struct {
	ID              string      `json:"_id"`
	ExperimentID    string      `json:"experimentId"`
	Cluster         string      `json:"cluster"`
	SchedulerJobID  string      `json:"schedulerJobId"`
	InputBasename   string      `json:"inputBasename"`
	ArraySpec       string      `json:"arraySpec"`
	State           queue.State `json:"state"`
	CancelRequested bool        `json:"cancelRequested"`
	SubmittedAt     int64       `json:"submittedAt"`
}

// QueuedJobStateUpdate is one item of the watcher's batched state report.
type QueuedJobStateUpdate struct {
	ID    string
	State queue.State
}

// RegisterQueuedJob records a submitted job on the backend and returns the
// queue row id. Idempotent per (cluster, schedulerJobId) while the row is
// active — see queue.register.
func (c *ConvexHTTPTracker) RegisterQueuedJob(ctx context.Context, r QueuedJobRegistration) (string, error) {
	args := map[string]any{
		"experimentId":   string(r.ExperimentID),
		"cluster":        r.Cluster,
		"scheduler":      r.Scheduler,
		"schedulerJobId": r.SchedulerJobID,
		"inputBasename":  r.InputBasename,
	}
	putNonEmpty(args, "arraySpec", r.ArraySpec)
	putPositive(args, "taskCount", r.TaskCount)
	raw, err := c.mutation(ctx, fnQueueRegister, args)
	if err != nil {
		return "", err
	}
	var id string
	if err := json.Unmarshal(raw, &id); err != nil {
		return "", fmt.Errorf("RegisterQueuedJob: %w", err)
	}
	return id, nil
}

// ListActiveQueuedJobs returns every job the backend still considers in
// flight (pending/running/unknown), scoped to the caller's org when auth is
// on and optionally narrowed to one cluster.
func (c *ConvexHTTPTracker) ListActiveQueuedJobs(ctx context.Context, orgID, cluster string) ([]QueuedJob, error) {
	args := map[string]any{}
	orgID, err := c.resolveOrg(ctx, orgID)
	if err != nil {
		return nil, err
	}
	putNonEmpty(args, "organizationId", orgID)
	putNonEmpty(args, "cluster", cluster)
	raw, err := c.query(ctx, fnQueueListActive, args)
	if err != nil {
		return nil, err
	}
	var jobs []QueuedJob
	if err := json.Unmarshal(raw, &jobs); err != nil {
		return nil, fmt.Errorf("ListActiveQueuedJobs: %w", err)
	}
	return jobs, nil
}

// UpdateQueuedJobStates pushes the watcher's observed states. The backend
// skips (rather than errors on) stale regressions; per-item results are only
// interesting to debugging, so they are discarded after the envelope check.
func (c *ConvexHTTPTracker) UpdateQueuedJobStates(ctx context.Context, updates []QueuedJobStateUpdate) error {
	if len(updates) == 0 {
		return nil
	}
	items := make([]map[string]any, len(updates))
	for i, u := range updates {
		items[i] = map[string]any{"id": u.ID, "state": u.State.String()}
	}
	_, err := c.mutation(ctx, fnQueueUpdateStates, map[string]any{"items": items})
	return err
}

// RequestQueuedJobCancel flips the cancel flag on a queue row (the CLI
// counterpart of the UI's cancel button). The actual scancel still happens
// on a login node.
func (c *ConvexHTTPTracker) RequestQueuedJobCancel(ctx context.Context, id string) error {
	_, err := c.mutation(ctx, fnQueueRequestCancel, map[string]any{"id": id})
	return err
}
