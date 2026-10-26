package submit

import (
	"fmt"
	"path/filepath"
	"strings"
)

// arrayListName is the file the array script indexes by task id.
const arrayListName = "input_list.txt"

// planArray builds a single SLURM array job over every input: one
// directory, one script, one queue entry, N tasks.
func planArray(req Request) (Job, error) {
	name := req.ArrayName
	if name == "" {
		name = "array"
	}
	// -array-name reaches the #SBATCH header and the scratch path, so it
	// gets the same treatment as an input basename.
	if err := validateInputName(name, true); err != nil {
		return Job{}, fmt.Errorf("-array-name %w", err)
	}
	dir := filepath.Join(req.JobsDir, name)

	var files []StagedFile
	var listLines []string
	res := Resources{}
	for _, in := range req.Inputs {
		ip, err := readInput(req, in)
		if err != nil {
			return Job{}, fmt.Errorf("%s: %w", in, err)
		}
		files = append(files, stagedFiles(req.SourceDir, dir, ip)...)
		// Each list line is the input followed by the files it needs, so
		// a task copies only its own dependencies into scratch instead of
		// dragging the whole array's inputs along.
		fields := []string{ip.name}
		for _, d := range ip.deps {
			fields = append(fields, d.Name)
		}
		listLines = append(listLines, strings.Join(fields, " "))
		// One array shares one resource request; the largest input's
		// needs are what every task must be given.
		res = maxResources(res, ip.res)
	}

	job := Job{
		Name:       name,
		Dir:        dir,
		ScriptPath: filepath.Join(dir, name+".sh"),
		Files:      dedupeFiles(files),
		Resources:  res,
		Inputs:     append([]string(nil), req.Inputs...),
		Array:      true,
		ListPath:   filepath.Join(dir, arrayListName),
		ListBody:   strings.Join(listLines, "\n") + "\n",
		Exists:     dirExists(dir),
	}
	job.Script = arrayScript(req, job)
	return job, nil
}

func maxResources(a, b Resources) Resources {
	out := a
	if b.Threads > out.Threads {
		out.Threads = b.Threads
	}
	if b.MaxCoreMB > out.MaxCoreMB {
		out.MaxCoreMB = b.MaxCoreMB
	}
	if b.MemoryMB > out.MemoryMB {
		out.MemoryMB = b.MemoryMB
		out.MemoryGB = b.MemoryGB
	}
	return out
}

// dedupeFiles drops repeated stagings of a shared dependency (several
// inputs commonly read the same .xyz or .hess).
func dedupeFiles(in []StagedFile) []StagedFile {
	seen := map[string]bool{}
	out := make([]StagedFile, 0, len(in))
	for _, f := range in {
		if seen[f.Dst] {
			continue
		}
		seen[f.Dst] = true
		out = append(out, f)
	}
	return out
}

// throttle resolves the concurrency cap: request first, then profile.
func throttle(req Request) int {
	if req.Throttle > 0 {
		return req.Throttle
	}
	return req.Profile.ArrayThrottle
}

// ArraySpec is the --array value a planned array job is queued with
// ("1-N" or "1-N%T"), and what the queue registration reports as the
// job's array shape. Empty for non-array jobs.
func (r Request) ArraySpec(job Job) string {
	if !job.Array {
		return ""
	}
	spec := fmt.Sprintf("1-%d", len(job.Inputs))
	if t := throttle(r); t > 0 {
		spec = fmt.Sprintf("%s%%%d", spec, t)
	}
	return spec
}

func arrayScript(req Request, job Job) string {
	c, p := req.Cluster, req.Profile
	spec := "--array=" + req.ArraySpec(job)

	s := &scriptBuilder{}
	s.directives(c, p, job.Name, job.Resources, []string{spec}, filepath.Join(job.Dir, "%A_%a"))
	s.linef("SOURCE=%s", shQuote(job.Dir))
	s.linef("LIST=%s", shQuote(job.ListPath))
	s.blank()
	s.line(`LINE=$(sed -n "${SLURM_ARRAY_TASK_ID}p" "$LIST")`)
	s.line(`if [ -z "$LINE" ]; then`)
	s.line(`    echo "no entry for array task $SLURM_ARRAY_TASK_ID in $LIST" >&2`)
	s.line(`    exit 1`)
	s.line(`fi`)
	s.line(`# First field is the input; any further fields are files it reads.`)
	s.line(`read -r INPUT DEPS <<< "$LINE"`)
	s.line(`FILENAME=${INPUT%.inp}`)
	s.blank()
	// The idempotency guard: resubmitting the array re-queues every task,
	// and without this a finished calculation would be overwritten by a
	// fresh run of itself.
	s.line(`if grep -q "ORCA TERMINATED NORMALLY" "$SOURCE/${FILENAME}.out" 2>/dev/null; then`)
	s.line(`    echo "already finished, skipping: $FILENAME"`)
	s.line(`    exit 0`)
	s.line(`fi`)
	s.blank()
	s.linef("TMP=%s", arrayScratchPath(c, job.Name))
	s.blank()
	s.scratchAndCleanup(c, p)
	s.line(`mkdir -p "$TMP"`)
	s.line(`cd "$SOURCE" || exit 1`)
	s.line(`# $DEPS is deliberately unquoted: it is a list of filenames.`)
	s.line(`cp "$INPUT" $DEPS "$TMP"/`)
	s.line(`cd "$TMP" || exit 1`)
	s.blank()
	s.emitOrcaCommand(c, orcaCommand(c, `"$INPUT"`, `"${FILENAME}.out"`, req.Experiment, req.Stream), req.Stream)
	return s.String()
}
