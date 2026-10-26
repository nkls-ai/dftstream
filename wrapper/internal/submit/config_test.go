package submit

import (
	"strings"
	"testing"

	"github.com/nkls-ai/dftstream/internal/levels"
)

func TestDefaultConfigParses(t *testing.T) {
	cfg, err := ParseConfig(DefaultConfigYAML())
	if err != nil {
		t.Fatalf("built-in config does not parse: %v", err)
	}
	cl, err := cfg.ClusterNamed("")
	if err != nil {
		t.Fatalf("default cluster: %v", err)
	}
	if cl.Name != "example" {
		t.Fatalf("default cluster = %q, want example", cl.Name)
	}
	for _, name := range []string{"cpu", "long", "express", "array"} {
		if _, err := cl.ProfileNamed(name); err != nil {
			t.Errorf("profile %q: %v", name, err)
		}
	}
	p, err := cl.ProfileNamed("")
	if err != nil {
		t.Fatalf("default profile: %v", err)
	}
	if p.Walltime != "24:00:00" || !p.OmitPartition {
		t.Errorf("default profile = %+v, want 24h and no partition directive", p)
	}
	if express, err := cl.ProfileNamed("express"); err != nil || express.Walltime != "" {
		t.Errorf("express profile = %+v (err %v), want no walltime", express, err)
	}
	if arr, err := cl.ProfileNamed("array"); err != nil || arr.ArrayThrottle != 30 {
		t.Errorf("array profile = %+v (err %v), want throttle 30", arr, err)
	}
}

func TestDefaultConfigSecondClusterDiffersEverywhere(t *testing.T) {
	cfg, err := ParseConfig(DefaultConfigYAML())
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	example, err := cfg.ClusterNamed("example")
	if err != nil {
		t.Fatalf("example: %v", err)
	}
	modules, err := cfg.ClusterNamed("modules")
	if err != nil {
		t.Fatalf("modules: %v", err)
	}
	if example.TasksDirective == modules.TasksDirective {
		t.Error("both clusters use the same tasks directive; the second cluster exists to prove it is configurable")
	}
	if len(modules.Modules) == 0 {
		t.Error("modules should load environment modules")
	}
	if example.Scratch.Base == modules.Scratch.Base {
		t.Error("both clusters share a scratch base")
	}
}

func TestParseConfigRejects(t *testing.T) {
	base := `
default_cluster: a
clusters:
  - name: a
    scheduler: slurm
    tasks_directive: ntasks
    orca_binary: /bin/orca
    scratch: {base: /tmp, layout: jobid}
    stream: {artifacts: essential, orbitals: none}
    default_profile: p
    profiles:
      - {name: p, partition: CPU, walltime: "1:00:00"}
`
	cases := map[string]struct{ yaml, want string }{
		"unknown field": {
			strings.Replace(base, "    orca_binary:", "    orca_bnary:", 1), "orca_bnary",
		},
		"bad enum": {
			strings.Replace(base, "scheduler: slurm", "scheduler: pbs", 1), "scheduler",
		},
		"bad layout": {
			strings.Replace(base, "layout: jobid", "layout: elsewhere", 1), "scratch.layout",
		},
		"missing default cluster": {
			strings.Replace(base, "default_cluster: a", "default_cluster: zz", 1), "zz",
		},
		"unknown default profile": {
			strings.Replace(base, "default_profile: p", "default_profile: q", 1), "default_profile",
		},
		"no clusters": {"clusters: []\n", "no clusters"},
		"bad artifact level": {
			strings.Replace(base, "artifacts: essential", "artifacts: lots", 1), "artifact level",
		},
		"bad orbital mode": {
			strings.Replace(base, "orbitals: none", "orbitals: some", 1), "orbital mode",
		},
		"missing orbitals": {
			strings.Replace(base, ", orbitals: none", "", 1), "stream.orbitals is required",
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := ParseConfig([]byte(tc.yaml))
			if err == nil {
				t.Fatalf("expected an error mentioning %q", tc.want)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %q does not mention %q", err, tc.want)
			}
		})
	}
}

// The stream levels accept every spelling `dftstream run` accepts, and the
// generated script always passes the canonical one.
func TestStreamLevelsAcceptRunAliases(t *testing.T) {
	yml := `
clusters:
  - name: a
    scheduler: slurm
    tasks_directive: ntasks
    orca_binary: /bin/orca
    scratch: {base: /tmp, layout: jobid}
    stream: {artifacts: max, orbitals: end}
    profiles:
      - {name: p, partition: CPU, walltime: "1:00:00"}
`
	cfg, err := ParseConfig([]byte(yml))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	cl := cfg.Clusters[0]
	if *cl.Stream.Artifacts != levels.ArtifactsAll || *cl.Stream.Orbitals != levels.OrbitalsFinal {
		t.Fatalf("stream = %v/%v, want all/final", *cl.Stream.Artifacts, *cl.Stream.Orbitals)
	}
	cmd := orcaCommand(cl, "'h2.inp'", "'h2.out'", "", true)
	if !strings.Contains(cmd, "run -artifacts all -orbitals final ") {
		t.Fatalf("command does not pass canonical levels: %s", cmd)
	}
}

func TestUnknownNamesListAlternatives(t *testing.T) {
	cfg, err := ParseConfig(DefaultConfigYAML())
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if _, err := cfg.ClusterNamed("nope"); err == nil || !strings.Contains(err.Error(), "example") {
		t.Fatalf("unknown cluster error should list the known ones, got %v", err)
	}
	cl, err := cfg.ClusterNamed("example")
	if err != nil {
		t.Fatalf("example: %v", err)
	}
	if _, err := cl.ProfileNamed("nope"); err == nil || !strings.Contains(err.Error(), "express") {
		t.Fatalf("unknown profile error should list the known ones, got %v", err)
	}
}

func TestExamplePaths(t *testing.T) {
	cfg, err := ParseConfig(DefaultConfigYAML())
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	cl, err := cfg.ClusterNamed("")
	if err != nil {
		t.Fatalf("cluster: %v", err)
	}
	if got := strings.Join(cl.ExamplePaths(), ","); got != "dftstream_binary,orca_binary" {
		t.Errorf("built-in ExamplePaths = %q, want both binaries", got)
	}
	cl.OrcaBinary, cl.DFTStreamBinary = "/opt/orca/orca", "dftstream"
	if got := cl.ExamplePaths(); len(got) != 0 {
		t.Errorf("edited cluster ExamplePaths = %v, want none", got)
	}
}
