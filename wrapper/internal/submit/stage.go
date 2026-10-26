package submit

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/nkls-ai/dftstream/internal/fsutil"
)

// ErrJobDirExists is returned when the job directory is already there and
// the caller did not ask to overwrite it.
var ErrJobDirExists = errors.New("job directory already exists")

// Materialize creates the job directory and fills it: a copy of every
// input and dependency, the input list for arrays, and the script.
//
// Only copies are made. The source .inp/.xyz/.hess/.gbw are opened
// read-only and never written to, so a job can be staged twice from the
// same directory without touching what ORCA produced there.
func Materialize(job Job, force bool) error {
	if job.Exists {
		if !force {
			return fmt.Errorf("%w: %s", ErrJobDirExists, job.Dir)
		}
		if err := removeJobDir(job); err != nil {
			return err
		}
	}
	if err := os.MkdirAll(job.Dir, 0o755); err != nil {
		return fmt.Errorf("create job dir: %w", err)
	}
	for _, f := range job.Files {
		if err := fsutil.CopyFile(f.Src, f.Dst); err != nil {
			return fmt.Errorf("stage %s: %w", filepath.Base(f.Src), err)
		}
	}
	if job.Array {
		if err := os.WriteFile(job.ListPath, []byte(job.ListBody), 0o644); err != nil {
			return fmt.Errorf("write %s: %w", arrayListName, err)
		}
	}
	if err := os.WriteFile(job.ScriptPath, []byte(job.Script), 0o755); err != nil {
		return fmt.Errorf("write submit script: %w", err)
	}
	return nil
}

// removeJobDir implements -force. It deletes results, so it refuses
// anything that is not the directory this job planned: a mistyped
// jobs_dir must not turn into a recursive delete of a project.
func removeJobDir(job Job) error {
	dir := filepath.Clean(job.Dir)
	if job.Name == "" || filepath.Base(dir) != job.Name || filepath.Dir(dir) == dir {
		return fmt.Errorf("refusing to remove %q: not a job directory named %q", dir, job.Name)
	}
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("overwrite job dir: %w", err)
	}
	return nil
}
