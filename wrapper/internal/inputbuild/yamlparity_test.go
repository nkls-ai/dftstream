package inputbuild

import (
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"

	"gopkg.in/yaml.v3"
)

// The browser builder loads presets/jobs.v1.yaml directly; the Go
// generators answer from jobKeywordTable. This test pins the two to each
// other: every YAML job must exist here with the identical '!' keywords,
// and every JobType here must be offered in the YAML — otherwise the UI
// and the CLI stop producing the same input for the same job.

type yamlJob struct {
	ID       string   `yaml:"id"`
	Keywords []string `yaml:"keywords"`
}

type yamlJobsFile struct {
	Version int       `yaml:"version"`
	Jobs    []yamlJob `yaml:"jobs"`
}

func loadJobsYAML(t *testing.T) yamlJobsFile {
	t.Helper()
	path := filepath.Join("..", "..", "..", "presets", "jobs.v1.yaml")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var f yamlJobsFile
	if err := yaml.Unmarshal(raw, &f); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	if f.Version != 1 {
		t.Fatalf("jobs.v1.yaml version = %d, want 1", f.Version)
	}
	return f
}

func TestJobsYAMLMatchesGoTable(t *testing.T) {
	f := loadJobsYAML(t)
	if len(f.Jobs) == 0 {
		t.Fatal("jobs.v1.yaml lists no jobs")
	}

	yamlIDs := make([]string, 0, len(f.Jobs))
	for _, j := range f.Jobs {
		yamlIDs = append(yamlIDs, j.ID)

		job, ok := ParseJobType(j.ID)
		if !ok {
			t.Errorf("jobs.v1.yaml job %q has no inputbuild.JobType — the CLI cannot reproduce it", j.ID)
			continue
		}
		want := job.Keywords()
		got := j.Keywords
		// YAML `keywords: []` and Go nil both mean "no run keywords".
		if len(want) == 0 && len(got) == 0 {
			continue
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("job %q keywords: yaml=%v go=%v — same job, different input", j.ID, got, want)
		}
	}

	goIDs := make([]string, 0, len(jobKeywordTable))
	for job := range jobKeywordTable {
		goIDs = append(goIDs, string(job))
	}
	sort.Strings(yamlIDs)
	sort.Strings(goIDs)
	if !reflect.DeepEqual(yamlIDs, goIDs) {
		t.Errorf("job id sets differ:\n  yaml: %v\n  go:   %v", yamlIDs, goIDs)
	}
}
