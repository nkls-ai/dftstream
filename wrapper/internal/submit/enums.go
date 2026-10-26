package submit

import "fmt"

// Scheduler is the batch system a cluster runs. Only SLURM emits today;
// the field exists so a PBS/LSF writer can be added without changing the
// config format.
type Scheduler string

const SchedulerSlurm Scheduler = "slurm"

var schedulers = []Scheduler{SchedulerSlurm}

// TasksDirective selects how the per-node core count is requested.
// Sites disagree: some want --ntasks, some insist on --ntasks-per-node.
type TasksDirective string

const (
	TasksNtasks        TasksDirective = "ntasks"
	TasksNtasksPerNode TasksDirective = "ntasks-per-node"
)

var tasksDirectives = []TasksDirective{TasksNtasks, TasksNtasksPerNode}

// Flag renders the directive as the sbatch flag name.
func (t TasksDirective) Flag() string { return string(t) }

// ScratchLayout selects the per-job path built under Scratch.Base.
type ScratchLayout string

const (
	// ScratchNameJobID → <base>/<job-name>/$SLURM_JOB_ID
	ScratchNameJobID ScratchLayout = "name-jobid"
	// ScratchJobID → <base>/$SLURM_JOB_ID
	ScratchJobID ScratchLayout = "jobid"
)

var scratchLayouts = []ScratchLayout{ScratchNameJobID, ScratchJobID}

// DepKind is a file kind an ORCA input can pull in from its directory.
// The job cannot start without these, so they are staged alongside it.
type DepKind string

const (
	DepXYZ    DepKind = "xyz"    // coordinates (* xyzfile …)
	DepAllXYZ DepKind = "allxyz" // NEB band / trajectory ensemble
	DepHess   DepKind = "hess"   // Hessian (%geom Hess_Filename, %irc, %freq)
	DepGBW    DepKind = "gbw"    // orbitals (%moinp, ! MORead)
)

// depKinds is the extension set scanned for. Ordered longest-first so the
// scanner's alternation prefers .allxyz over .xyz.
var depKinds = []DepKind{DepAllXYZ, DepXYZ, DepHess, DepGBW}

// validate checks a value against its allowed set and returns an error
// naming every accepted spelling — a typo in a YAML config must never be
// silently ignored into a zero value.
func validate[T ~string](field string, got T, allowed []T) error {
	for _, a := range allowed {
		if got == a {
			return nil
		}
	}
	names := make([]string, 0, len(allowed))
	for _, a := range allowed {
		names = append(names, string(a))
	}
	return fmt.Errorf("%s: %q is not valid (want one of %v)", field, string(got), names)
}
