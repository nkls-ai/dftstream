package cli

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/nkls-ai/dftstream/internal/cliui"
	"github.com/nkls-ai/dftstream/internal/submit"
)

// submitFlags is the parsed command line for `dftstream submit`.
type submitFlags struct {
	cluster     string
	configPath  string
	profile     string
	long        bool
	express     bool
	jobsDir     string
	experiment  string
	stream      bool
	force       bool
	array       bool
	arrayName   string
	throttle    int
	dryRun      bool
	doSubmit    bool
	printConfig bool
}

// SubmitCmd implements `dftstream submit`: stage an ORCA input into a
// job directory and write the scheduler script for it. Exit codes: 0 ok,
// 1 failure, 2 usage error.
func SubmitCmd(args []string) int {
	fs := flag.NewFlagSet("submit", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	f := &submitFlags{}
	fs.StringVar(&f.cluster, "cluster", "", "cluster profile to use (default: the config's default_cluster)")
	fs.StringVar(&f.configPath, "config", "", "cluster config file (default: $DFTSTREAM_CLUSTERS, ./clusters.yaml, ~/.config/dftstream/clusters.yaml, built-in)")
	fs.StringVar(&f.profile, "profile", "", "queue profile: partition + walltime (default: the cluster's default_profile)")
	fs.BoolVar(&f.long, "long", false, `shorthand for -profile long`)
	fs.BoolVar(&f.express, "express", false, `shorthand for -profile express`)
	fs.StringVar(&f.jobsDir, "jobs-dir", "", "where job directories are created (default: the cluster's jobs_dir)")
	fs.StringVar(&f.experiment, "exp", "", "experiment name for tracking (default: the jobs directory's project folder)")
	fs.BoolVar(&f.stream, "stream", true, "run ORCA through `dftstream run` so the job is tracked")
	fs.BoolVar(&f.force, "force", false, "overwrite an existing job directory (deletes its previous results)")
	fs.BoolVar(&f.array, "array", false, "submit all inputs as one job array instead of one job each")
	fs.StringVar(&f.arrayName, "array-name", "", "job and directory name for -array (default: array)")
	fs.IntVar(&f.throttle, "throttle", 0, "max array tasks running at once (default: the profile's array_throttle)")
	fs.BoolVar(&f.dryRun, "dry-run", false, "print the generated script(s) and change nothing")
	fs.BoolVar(&f.doSubmit, "submit", false, "hand the staged script to sbatch")
	fs.BoolVar(&f.printConfig, "print-config", false, "print the built-in cluster config and exit")
	fs.Usage = func() { submitUsage(fs) }
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if f.printConfig {
		if _, err := os.Stdout.Write(submit.DefaultConfigYAML()); err != nil {
			cliui.Error(os.Stderr, fmt.Sprintf("write config: %v", err), "")
			return 1
		}
		return 0
	}
	if f.long && f.express {
		cliui.Error(os.Stderr, "-long and -express select different queues", "Pick one, or name a profile with -profile.")
		return 2
	}
	if fs.NArg() == 0 {
		cliui.Error(os.Stderr, "expected at least one input file", "Example: dftstream submit opt-freq_x.inp   (or: dftstream submit all)")
		fs.Usage()
		return 2
	}

	req, err := buildSubmitRequest(f, fs.Args())
	if err != nil {
		cliui.Error(os.Stderr, err.Error(), "")
		return 1
	}
	jobs, err := submit.Plan(req)
	if err != nil {
		cliui.Error(os.Stderr, err.Error(), "")
		return 1
	}
	return runSubmitJobs(req, jobs, f)
}

// buildSubmitRequest resolves config, cluster, profile, directories and
// the input list into a submit.Request.
func buildSubmitRequest(f *submitFlags, args []string) (submit.Request, error) {
	cfg, source, err := submit.LoadConfig(f.configPath)
	if err != nil {
		return submit.Request{}, err
	}
	cluster, err := cfg.ClusterNamed(f.cluster)
	if err != nil {
		return submit.Request{}, fmt.Errorf("%w (config: %s)", err, source)
	}
	if fields := cluster.ExamplePaths(); len(fields) > 0 {
		msg := fmt.Sprintf("cluster %q still has the example %s (config: %s)", cluster.Name, strings.Join(fields, " and "), source)
		fix := "Copy the config with `dftstream submit -print-config > ~/.config/dftstream/clusters.yaml` and set your own paths."
		if f.doSubmit {
			return submit.Request{}, fmt.Errorf("%s. %s", msg, fix)
		}
		cliui.Warning(os.Stderr, msg, fix)
	}
	profile, err := cluster.ProfileNamed(profileName(f, cluster))
	if err != nil {
		return submit.Request{}, err
	}

	sourceDir, err := os.Getwd()
	if err != nil {
		return submit.Request{}, fmt.Errorf("resolve working directory: %w", err)
	}
	jobsDir, err := resolveJobsDir(f.jobsDir, cluster.JobsDir, sourceDir)
	if err != nil {
		return submit.Request{}, err
	}
	inputs, err := collectInputs(sourceDir, args)
	if err != nil {
		return submit.Request{}, err
	}
	experiment := f.experiment
	if experiment == "" {
		// The project folder holding jobs/ is the experiment, which is
		// how these directories are already organized.
		experiment = filepath.Base(filepath.Dir(jobsDir))
	}
	return submit.Request{
		Cluster:    cluster,
		Profile:    profile,
		SourceDir:  sourceDir,
		JobsDir:    jobsDir,
		Inputs:     inputs,
		Experiment: experiment,
		Stream:     f.stream,
		Array:      f.array,
		ArrayName:  f.arrayName,
		Throttle:   f.throttle,
	}, nil
}

func profileName(f *submitFlags, cluster submit.Cluster) string {
	switch {
	case f.profile != "":
		return f.profile
	case f.long:
		return "long"
	case f.express:
		return "express"
	case f.array && cluster.ArrayProfile != "":
		return cluster.ArrayProfile
	default:
		return ""
	}
}

func resolveJobsDir(flagVal, clusterVal, sourceDir string) (string, error) {
	dir := flagVal
	if dir == "" {
		dir = clusterVal
	}
	if dir == "" {
		return "", errors.New("no jobs directory: set jobs_dir in the cluster config or pass -jobs-dir")
	}
	if !filepath.IsAbs(dir) {
		dir = filepath.Join(sourceDir, dir)
	}
	return filepath.Clean(dir), nil
}

// collectInputs expands the positional arguments: "all" means every .inp
// in the working directory, sorted for a stable array order.
func collectInputs(dir string, args []string) ([]string, error) {
	if len(args) == 1 && args[0] == "all" {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", dir, err)
		}
		var out []string
		for _, e := range entries {
			if !e.IsDir() && strings.EqualFold(filepath.Ext(e.Name()), ".inp") {
				out = append(out, e.Name())
			}
		}
		if len(out) == 0 {
			return nil, fmt.Errorf("no .inp files in %s", dir)
		}
		sort.Strings(out)
		return out, nil
	}
	out := make([]string, 0, len(args))
	for _, a := range args {
		if filepath.Dir(a) != "." {
			return nil, fmt.Errorf("%s: submit inputs from the directory they live in (the job stages that directory's files)", a)
		}
		if !strings.EqualFold(filepath.Ext(a), ".inp") {
			return nil, fmt.Errorf("%s: not an ORCA input file (.inp)", a)
		}
		out = append(out, a)
	}
	return out, nil
}

// runSubmitJobs materializes and optionally queues each planned job. Jobs
// sbatch accepted are then registered with the tracking backend (best-effort)
// so the UI's queue view sees them before any run exists.
func runSubmitJobs(req submit.Request, jobs []submit.Job, f *submitFlags) int {
	failed := false
	var submitted []submittedJob
	for _, job := range jobs {
		if f.dryRun {
			printDryRun(job)
			continue
		}
		if err := submit.Materialize(job, f.force); err != nil {
			if errors.Is(err, submit.ErrJobDirExists) {
				cliui.Warning(os.Stderr, fmt.Sprintf("%s: job directory exists, skipping", job.Name),
					"Pass -force to overwrite it (this deletes the results already there).")
				continue
			}
			cliui.Error(os.Stderr, fmt.Sprintf("%s: %v", job.Name, err), "")
			failed = true
			continue
		}
		cliui.Success(os.Stderr, fmt.Sprintf("%s staged: %s", job.Name, describeJob(job)))
		if !f.doSubmit {
			// The queue command goes to stdout, alone on its line, so it
			// can be piped straight into a shell; the staging chatter
			// above it is on stderr.
			if _, err := fmt.Fprintln(os.Stdout, submit.SubmitCommand(job)); err != nil {
				cliui.Error(os.Stderr, fmt.Sprintf("write stdout: %v", err), "")
				failed = true
			}
			continue
		}
		reply, err := submit.Submit(job)
		if err != nil {
			fix := ""
			if errors.Is(err, submit.ErrNoScheduler) {
				fix = "The job is staged; submit it from a login node with: " + submit.SubmitCommand(job)
			}
			cliui.Error(os.Stderr, fmt.Sprintf("%s: %v", job.Name, err), fix)
			failed = true
			continue
		}
		cliui.Success(os.Stderr, reply)
		if jobID, ok := submit.ParseJobID(reply); ok {
			submitted = append(submitted, submittedJob{job: job, jobID: jobID})
		} else {
			// A site-patched sbatch that rewrites its output: the job is
			// queued, we just cannot register what we cannot identify.
			cliui.Warning(os.Stderr, fmt.Sprintf("%s: could not read a job id from the sbatch reply; skipping queue registration", job.Name), "")
		}
	}
	registerSubmittedJobs(req, submitted)
	if failed {
		return 1
	}
	return 0
}

func describeJob(job submit.Job) string {
	res := job.Resources
	what := fmt.Sprintf("%d task(s), %d cores, %dG", len(job.Inputs), res.Threads, res.MemoryGB)
	if job.Array {
		return what + ", array"
	}
	return what
}

func printDryRun(job submit.Job) {
	cliui.Title(os.Stdout, fmt.Sprintf("%s → %s", job.Name, job.ScriptPath))
	for _, file := range job.Files {
		fmt.Fprintf(os.Stdout, "# stage %s\n", file.Dst)
	}
	if job.Array {
		fmt.Fprintf(os.Stdout, "# write %s\n%s", job.ListPath, job.ListBody)
	}
	fmt.Fprintln(os.Stdout, job.Script)
}

func submitUsage(fs *flag.FlagSet) {
	cliui.Title(os.Stderr, "dftstream submit")
	fmt.Fprintf(os.Stderr, `
Usage:
  dftstream submit [flags] <input.inp>...
  dftstream submit [flags] all

Stages each input into its own job directory next to the project (the
input plus every .xyz/.hess/.allxyz/.gbw it references), sizes cores and
memory from %%pal and %%maxcore, and writes a scheduler script that runs
the calculation on node-local scratch and copies the results back.

Nothing is queued unless you pass -submit.

Flags:
`)
	fs.PrintDefaults()
}
