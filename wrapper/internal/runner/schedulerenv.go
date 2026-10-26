package runner

import "os"

// schedulerJobIDFromEnv reports the SLURM job the current process runs
// under, or "" off-cluster. Inside an array task SLURM_JOB_ID is the task's
// own (unique) id while SLURM_ARRAY_JOB_ID is the id sbatch printed at
// submission — the one the queuedJobs row was registered with — so array
// tasks report "<arrayJobId>_<taskIdx>", which the backend's link step can
// reduce back to the base id.
func schedulerJobIDFromEnv() string {
	if base := os.Getenv("SLURM_ARRAY_JOB_ID"); base != "" {
		if task := os.Getenv("SLURM_ARRAY_TASK_ID"); task != "" {
			return base + "_" + task
		}
		return base
	}
	return os.Getenv("SLURM_JOB_ID")
}
