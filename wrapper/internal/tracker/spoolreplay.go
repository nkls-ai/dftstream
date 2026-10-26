package tracker

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/nkls-ai/dftstream/internal/levels"
)

// Convex function paths of the spool replay guards (db/convex/spool.ts).
//
// The append-family mutations (runs:create, events:appendMany, …) blindly
// insert, so replaying a journal through them a second time — a sync that
// crashed after the mutation committed but before the cursor was persisted —
// would duplicate rows. The spool:* variants take a client-generated
// idempotency key and record it in the same transaction as the write, making
// replay exactly-once. The already-idempotent operations (ensure*,
// updateStatus, geometries:append, the setAll family, artifact upserts) are
// replayed through their normal mutations.
const (
	fnSpoolCreateRun        = "spool:createRun"
	fnSpoolAppendEvents     = "spool:appendEvents"
	fnSpoolAppendMetrics    = "spool:appendMetrics"
	fnSpoolAppendLogs       = "spool:appendLogs"
	fnSpoolAppendSysSamples = "spool:appendSysSamples"
)

// FeatureSpool is the meta:version feature name a backend advertises once
// the spool:* replay guards are deployed.
const FeatureSpool = "spool"

// SpoolReplayer is the backend surface `dftstream sync` replays a journal
// against: the guarded (exactly-once) writes plus the subset of Tracker whose
// mutations are already safe to retry. A fake implementation of this
// interface is what the spool integration tests capture ops with.
type SpoolReplayer interface {
	// Guarded, exactly-once writes (key = journal idempotency key).
	SpoolCreateRun(ctx context.Context, key string, r RunCreate) (RunID, error)
	SpoolAppendEvents(ctx context.Context, key string, runID RunID, events []Event) error
	SpoolAppendMetrics(ctx context.Context, key string, runID RunID, metrics []Metric) error
	SpoolAppendLogs(ctx context.Context, key string, runID RunID, entries []LogEntry) error
	SpoolAppendSysSamples(ctx context.Context, key string, runID RunID, samples []SysSample) error

	// Naturally idempotent operations, replayed through the live mutations.
	EnsureExperiment(ctx context.Context, orgID, name string) (ExperimentID, error)
	EnsureBatch(ctx context.Context, expID ExperimentID, name string, artifactLevel levels.ArtifactLevel) (BatchID, error)
	UpdateRunStatus(ctx context.Context, runID RunID, u StatusUpdate) error
	AppendGeometry(ctx context.Context, runID RunID, cycle int, xyz string) error
	SetFrequencies(ctx context.Context, runID RunID, items []Frequency) error
	SetExcitedStates(ctx context.Context, runID RunID, items []ExcitedState) error
	SetNMRShields(ctx context.Context, runID RunID, items []NMRShield) error
	SetArtifacts(ctx context.Context, runID RunID, items []Artifact) error
	// UpsertArtifacts also stands in for journaled *append* artifact ops:
	// replace-same-name/append-rest semantics make a replay idempotent where
	// a literal append would duplicate rows.
	UpsertArtifacts(ctx context.Context, runID RunID, items []Artifact) error
}

func (c *ConvexHTTPTracker) SpoolCreateRun(ctx context.Context, key string, r RunCreate) (RunID, error) {
	args := runCreateArgs(r)
	args["key"] = key
	raw, err := c.mutation(ctx, fnSpoolCreateRun, args)
	if err != nil {
		return "", err
	}
	var id string
	if err := json.Unmarshal(raw, &id); err != nil {
		return "", fmt.Errorf("SpoolCreateRun: %w", err)
	}
	if id == "" {
		return "", fmt.Errorf("SpoolCreateRun: backend returned no run id for key %s", key)
	}
	return RunID(id), nil
}

func (c *ConvexHTTPTracker) SpoolAppendEvents(ctx context.Context, key string, runID RunID, events []Event) error {
	if len(events) == 0 {
		return nil
	}
	_, err := c.mutation(ctx, fnSpoolAppendEvents, map[string]any{
		"key": key, "runId": runID, "items": eventItems(events),
	})
	return err
}

func (c *ConvexHTTPTracker) SpoolAppendMetrics(ctx context.Context, key string, runID RunID, metrics []Metric) error {
	if len(metrics) == 0 {
		return nil
	}
	_, err := c.mutation(ctx, fnSpoolAppendMetrics, map[string]any{
		"key": key, "runId": runID, "items": metricItems(metrics),
	})
	return err
}

func (c *ConvexHTTPTracker) SpoolAppendLogs(ctx context.Context, key string, runID RunID, entries []LogEntry) error {
	if len(entries) == 0 {
		return nil
	}
	_, err := c.mutation(ctx, fnSpoolAppendLogs, map[string]any{
		"key": key, "runId": runID, "items": logItems(entries),
	})
	return err
}

func (c *ConvexHTTPTracker) SpoolAppendSysSamples(ctx context.Context, key string, runID RunID, samples []SysSample) error {
	if len(samples) == 0 {
		return nil
	}
	_, err := c.mutation(ctx, fnSpoolAppendSysSamples, map[string]any{
		"key": key, "runId": runID, "items": sysSampleItems(samples),
	})
	return err
}

var _ SpoolReplayer = (*ConvexHTTPTracker)(nil)
