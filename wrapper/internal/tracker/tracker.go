// Package tracker abstracts the DFTStream storage backend.
package tracker

import (
	"context"
	"time"

	"github.com/nkls-ai/dftstream/internal/artifacts"
	"github.com/nkls-ai/dftstream/internal/levels"
)

type ExperimentID string

type BatchID string

type RunID string

type RunStatus string

const (
	StatusPending  RunStatus = "pending"
	StatusRunning  RunStatus = "running"
	StatusFinished RunStatus = "finished"
	StatusFailed   RunStatus = "failed"
)

type RunCreate struct {
	ExperimentID ExperimentID
	BatchID      BatchID
	BatchParams  map[string]any
	Name         string
	Hostname     string
	NCores       int
	NProcs       int
	MaxCoreMB    int
	OrcaVersion  string
	JobType      string
	InputPath    string
	InputText    string
	CWD          string

	// Parsed from the ORCA input '!' line(s). Empty if not detected.
	Keywords     []string
	Functional   string
	Basis        string
	Method       string
	RunTypes     []string
	ScfTier      string
	OptTier      string
	Grid         string
	Solvent      string
	SolventModel string
	Corrections  []string
	Charge       *int
	Mult         *int
	SubmittedBy  string
	// DFTStreamVersion is the wrapper build that tracked this run (e.g.
	// "v0.3.2"), so a run can be tied back to the exact tool that produced it.
	DFTStreamVersion string
	// SchedulerJobID is the batch-scheduler job the run executes under
	// (SLURM_JOB_ID; array tasks "<arrayJobId>_<taskIdx>"). Empty off-cluster.
	// Lets the backend collapse the queuedJobs row onto this run.
	SchedulerJobID string
	// Workflow lineage, resolved from the input's provenance comment
	// (restart / `dftstream next` outputs). Empty when unknown.
	ParentRunID    RunID
	ParentEdgeKind string
}

type StatusUpdate struct {
	Status         RunStatus
	ExitCode       *int
	FinishedAt     *time.Time
	LastEnergy     *float64
	OrcaVersion    *string
	NProcs         *int
	WallclockSec   *float64
	Converged      *bool
	OptMaxCycles   *bool // optimizer stopped at the cycle limit (not a crash)
	ImaginaryModes *int

	// Thermochemistry (all Hartree), from the last THERMOCHEMISTRY
	// section of the output.
	ZPEEh         *float64
	EnthalpyEh    *float64
	EntropyCorrEh *float64
	GibbsEh       *float64
	GMinusEEh     *float64

	// Spin contamination from the last <S**2> block (UHF/UKS only).
	S2      *float64
	S2Ideal *float64

	// Why the run failed or stalled, as classified by the parser
	// (parser.ErrorClass values), plus a short excerpt of the output around
	// the diagnosis so a batch dashboard can group failures without opening
	// every .out. Both nil on a clean run.
	ErrorClass   *string
	ErrorExcerpt *string
}

type Event struct {
	Seq     int64
	TS      time.Time
	Kind    string
	Payload map[string]any
}

type Metric struct {
	Key   string
	TS    time.Time
	Cycle *int
	Iter  *int
	Value float64
}

type Frequency struct {
	Idx         int
	Wavenumber  float64
	Imaginary   bool
	IRIntensity float64
	// HessIdx is the 1-based ordinal of the hessian calculation the mode
	// belongs to; 0 means unknown (legacy single-hessian semantics).
	HessIdx int
}

type SysSample struct {
	TS      time.Time
	CPUPct  float64
	RSSMB   float64
	Threads int
}

// Artifact is the per-file record uploaded to the backend. It is the
// artifacts package's type: one definition, no conversion layer.
type Artifact = artifacts.Artifact

type LogEntry struct {
	TS      time.Time
	Level   string // debug|info|warn|error
	Message string
	Fields  map[string]any
}

type OrbitalTransition struct {
	From  string
	To    string
	Coeff float64
}

type ExcitedState struct {
	Idx          int
	EnergyEV     float64
	WavelengthNM float64
	OscStrength  float64
	Transitions  []OrbitalTransition
}

type NMRShield struct {
	AtomIdx    int
	Element    string
	Isotropic  float64
	Anisotropy float64
}

// Capability interfaces. Consumers that need only a slice of the
// backend (the sysinfo sampler, the logging sink, ...) depend on the
// narrow interface; Tracker composes them for the runner and CLI, which
// genuinely exercise the whole surface.

// RunLifecycle creates/locates the experiment, batch and run rows and
// updates run status.
type RunLifecycle interface {
	// orgID is the organization the experiment belongs to (required when the
	// deployment enforces auth; pass "" for single-user/local deployments).
	EnsureExperiment(ctx context.Context, orgID, name string) (ExperimentID, error)
	EnsureBatch(ctx context.Context, expID ExperimentID, name string, artifactLevel levels.ArtifactLevel) (BatchID, error)
	CreateRun(ctx context.Context, r RunCreate) (RunID, error)
	FindRunByName(ctx context.Context, expID ExperimentID, name string) (RunID, error)
	UpdateRunStatus(ctx context.Context, runID RunID, u StatusUpdate) error
}

// StreamAppender receives the high-frequency per-event rows emitted
// while ORCA runs.
type StreamAppender interface {
	AppendEvent(ctx context.Context, runID RunID, e Event) error
	AppendMetric(ctx context.Context, runID RunID, m Metric) error
	AppendGeometry(ctx context.Context, runID RunID, cycle int, xyz string) error
}

// SysSampleAppender records resource-usage samples of the ORCA process.
type SysSampleAppender interface {
	AppendSysSample(ctx context.Context, runID RunID, s SysSample) error
}

// LogAppender persists structured wrapper log entries.
type LogAppender interface {
	AppendLogs(ctx context.Context, runID RunID, entries []LogEntry) error
}

// SectionWriter stores whole parsed output sections (set-style,
// replacing any previous value for the run).
type SectionWriter interface {
	SetFrequencies(ctx context.Context, runID RunID, items []Frequency) error
	SetExcitedStates(ctx context.Context, runID RunID, items []ExcitedState) error
	SetNMRShields(ctx context.Context, runID RunID, items []NMRShield) error
}

// ArtifactWriter uploads artifact manifests.
type ArtifactWriter interface {
	SetArtifacts(ctx context.Context, runID RunID, items []Artifact) error
	AppendArtifacts(ctx context.Context, runID RunID, items []Artifact) error
	// UpsertArtifacts replaces same-named rows and appends the rest —
	// used to refresh growing files (NEB paths) while the run is live.
	UpsertArtifacts(ctx context.Context, runID RunID, items []Artifact) error
}

// Tracker is the full storage abstraction every backend implements.
//
// All Append* calls are expected to be non-blocking from the caller's
// point of view in typical use — concrete trackers may buffer/batch.
// Close drains pending buffers and must be called before exit.
type Tracker interface {
	RunLifecycle
	StreamAppender
	SysSampleAppender
	LogAppender
	SectionWriter
	ArtifactWriter
	Close(ctx context.Context) error
}
