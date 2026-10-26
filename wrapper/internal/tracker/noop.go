package tracker

import (
	"context"

	"github.com/nkls-ai/dftstream/internal/levels"
)

type NoopTracker struct{}

func NewNoopTracker() *NoopTracker { return &NoopTracker{} }

func (NoopTracker) EnsureExperiment(context.Context, string, string) (ExperimentID, error) {
	return "noop-exp", nil
}
func (NoopTracker) EnsureBatch(context.Context, ExperimentID, string, levels.ArtifactLevel) (BatchID, error) {
	return "noop-batch", nil
}
func (NoopTracker) CreateRun(context.Context, RunCreate) (RunID, error) { return "noop-run", nil }
func (NoopTracker) FindRunByName(context.Context, ExperimentID, string) (RunID, error) {
	return "", nil
}
func (NoopTracker) UpdateRunStatus(context.Context, RunID, StatusUpdate) error {
	return nil
}
func (NoopTracker) AppendEvent(context.Context, RunID, Event) error               { return nil }
func (NoopTracker) AppendMetric(context.Context, RunID, Metric) error             { return nil }
func (NoopTracker) AppendGeometry(context.Context, RunID, int, string) error      { return nil }
func (NoopTracker) SetFrequencies(context.Context, RunID, []Frequency) error      { return nil }
func (NoopTracker) AppendSysSample(context.Context, RunID, SysSample) error       { return nil }
func (NoopTracker) SetArtifacts(context.Context, RunID, []Artifact) error         { return nil }
func (NoopTracker) AppendArtifacts(context.Context, RunID, []Artifact) error      { return nil }
func (NoopTracker) UpsertArtifacts(context.Context, RunID, []Artifact) error      { return nil }
func (NoopTracker) AppendLogs(context.Context, RunID, []LogEntry) error           { return nil }
func (NoopTracker) SetExcitedStates(context.Context, RunID, []ExcitedState) error { return nil }
func (NoopTracker) SetNMRShields(context.Context, RunID, []NMRShield) error       { return nil }
func (NoopTracker) Close(context.Context) error                                   { return nil }

// BackendVersion has no deployment to interrogate — `noop://` is the
// offline/overhead-test sink — so it reports the handshake as
// unperformable rather than inventing a version.
func (NoopTracker) BackendVersion(context.Context) (BackendVersion, error) {
	return BackendVersion{}, ErrVersionUnsupported
}

var _ VersionReporter = NoopTracker{}
var _ VersionReporter = (*ConvexHTTPTracker)(nil)
var _ VersionReporter = (*BatchingTracker)(nil)
