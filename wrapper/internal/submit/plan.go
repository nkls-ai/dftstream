package submit

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Request describes one `dftstream submit` invocation.
type Request struct {
	Cluster   Cluster
	Profile   Profile
	SourceDir string   // directory the .inp files live in
	JobsDir   string   // directory job directories are created in
	Inputs    []string // .inp basenames, in submission order

	Experiment string // `dftstream run -exp`; empty derives from JobsDir's parent
	Stream     bool   // route ORCA through `dftstream run`

	Array     bool
	ArrayName string // job (and directory) name for the array
	Throttle  int    // overrides the profile's array_throttle when > 0
}

// StagedFile is one copy made into a job directory.
type StagedFile struct {
	Src, Dst string
}

// Job is a fully planned job directory: what to copy where, and the
// script to write. Nothing has touched the filesystem yet.
type Job struct {
	Name       string
	Dir        string
	ScriptPath string
	Script     string
	Files      []StagedFile
	Resources  Resources
	Inputs     []string // .inp basenames this job runs
	Array      bool
	ListPath   string // array only: the input_list.txt path
	ListBody   string
	Exists     bool // job directory is already there
}

// Plan works out every job the request produces, reading the inputs and
// their dependencies but writing nothing.
func Plan(req Request) ([]Job, error) {
	if len(req.Inputs) == 0 {
		return nil, errors.New("no input files")
	}
	if req.Array {
		job, err := planArray(req)
		if err != nil {
			return nil, err
		}
		return []Job{job}, nil
	}
	jobs := make([]Job, 0, len(req.Inputs))
	for _, in := range req.Inputs {
		job, err := planSingle(req, in)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", in, err)
		}
		jobs = append(jobs, job)
	}
	return jobs, nil
}

// inputPlan is the per-input reading step shared by both modes.
type inputPlan struct {
	name string // basename, e.g. "opt-freq_x.inp"
	stem string
	deps []Dep
	res  Resources
}

// validateInputName rejects basenames that the generated script cannot
// represent safely no matter how they are quoted.
//
// A newline is the sharp one: the name is interpolated into
// `#SBATCH --job-name=<name>`, and a second line inside it becomes
// another scheduler directive — or, past the header, a shell line. A
// control character has no legitimate place in an ORCA filename either.
//
// For an array the bar is higher: input_list.txt is one whitespace-
// separated record per task and the script splits it with `read -r`, so
// a name containing a space cannot survive the round trip and is refused
// rather than silently staged as two fields.
func validateInputName(name string, array bool) error {
	for _, r := range name {
		if r == '\n' || r == '\r' {
			return fmt.Errorf("%q: file name contains a line break", name)
		}
		if r < 0x20 || r == 0x7f {
			return fmt.Errorf("%q: file name contains a control character (%#U)", name, r)
		}
	}
	if array && strings.ContainsAny(name, " \t") {
		return fmt.Errorf(
			"%q: -array indexes inputs through a whitespace-separated list, so an input name cannot contain a space; "+
				"rename it or submit these inputs without -array", name)
	}
	return nil
}

func readInput(req Request, name string) (inputPlan, error) {
	if err := validateInputName(name, req.Array); err != nil {
		return inputPlan{}, err
	}
	path := filepath.Join(req.SourceDir, name)
	text, err := os.ReadFile(path)
	if err != nil {
		return inputPlan{}, err
	}
	stem := strings.TrimSuffix(name, filepath.Ext(name))
	deps, err := resolveDeps(req.SourceDir, stem, ScanDeps(string(text)))
	if err != nil {
		return inputPlan{}, err
	}
	res, err := ResourcesFor(string(text))
	if err != nil {
		return inputPlan{}, err
	}
	return inputPlan{name: name, stem: stem, deps: deps, res: res}, nil
}

func planSingle(req Request, name string) (Job, error) {
	ip, err := readInput(req, name)
	if err != nil {
		return Job{}, err
	}
	dir := filepath.Join(req.JobsDir, ip.stem)
	job := Job{
		Name:       ip.stem,
		Dir:        dir,
		ScriptPath: filepath.Join(dir, ip.stem+".sh"),
		Files:      stagedFiles(req.SourceDir, dir, ip),
		Resources:  ip.res,
		Inputs:     []string{ip.name},
		Exists:     dirExists(dir),
	}
	job.Script = singleScript(req, job, ip)
	return job, nil
}

func stagedFiles(srcDir, dstDir string, ip inputPlan) []StagedFile {
	files := []StagedFile{{
		Src: filepath.Join(srcDir, ip.name),
		Dst: filepath.Join(dstDir, ip.name),
	}}
	for _, d := range ip.deps {
		files = append(files, StagedFile{
			Src: filepath.Join(srcDir, d.Name),
			Dst: filepath.Join(dstDir, d.Name),
		})
	}
	return files
}

func dirExists(p string) bool {
	st, err := os.Stat(p)
	// A stat error other than "not there" (a permission problem, say)
	// still means we cannot treat the directory as free; the mkdir in
	// Materialize reports the real reason.
	return err == nil && st.IsDir()
}

// singleScript renders the one-job script: stage into node-local
// scratch, run, copy results back.
func singleScript(req Request, job Job, ip inputPlan) string {
	c, p := req.Cluster, req.Profile
	s := &scriptBuilder{}
	s.directives(c, p, job.Name, job.Resources, nil, filepath.Join(job.Dir, job.Name))
	s.linef("SOURCE=%s", shQuote(job.Dir))
	s.linef("TMP=%s", scratchPath(c, job.Name))
	s.blank()
	s.scratchAndCleanup(c, p)
	s.line(`mkdir -p "$TMP"`)
	s.line(`find "$SOURCE" -maxdepth 1 -type f -exec cp {} "$TMP"/ \;`)
	s.line(`cd "$TMP" || exit 1`)
	s.blank()
	s.emitOrcaCommand(c, orcaCommand(c, shQuote(ip.name), shQuote(ip.stem+".out"), req.Experiment, req.Stream), req.Stream)
	return s.String()
}
