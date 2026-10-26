// Package submit turns an ORCA input file into a staged job directory
// plus a scheduler script, so that submitting a calculation is a command
// rather than a per-cluster copy of a shell-script generator.
//
// Everything site-specific — binaries, modules, scratch filesystem,
// partitions, walltimes — lives in a YAML cluster config (see
// clusters.default.yaml); nothing about a cluster is compiled in.
package submit

import (
	"bytes"
	_ "embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/nkls-ai/dftstream/internal/levels"
	"gopkg.in/yaml.v3"
)

//go:embed clusters.default.yaml
var defaultClustersYAML []byte

// DefaultConfigYAML returns the built-in cluster config, for
// `dftstream submit -print-config`.
func DefaultConfigYAML() []byte { return defaultClustersYAML }

// Config is the whole clusters.yaml file.
type Config struct {
	DefaultCluster string    `yaml:"default_cluster"`
	Clusters       []Cluster `yaml:"clusters"`
}

// Cluster is one machine's site configuration.
type Cluster struct {
	Name            string            `yaml:"name"`
	Description     string            `yaml:"description"`
	Scheduler       Scheduler         `yaml:"scheduler"`
	TasksDirective  TasksDirective    `yaml:"tasks_directive"`
	OrcaBinary      string            `yaml:"orca_binary"`
	DFTStreamBinary string            `yaml:"dftstream_binary"`
	OrcaArgs        []string          `yaml:"orca_args"`
	Modules         []string          `yaml:"modules"`
	Env             map[string]string `yaml:"env"`
	JobsDir         string            `yaml:"jobs_dir"`
	Scratch         Scratch           `yaml:"scratch"`
	Stream          StreamOptions     `yaml:"stream"`
	// ComputeNodesOffline says this cluster's compute nodes cannot reach the
	// tracking backend (the common firewalled-cluster setup). Streamed jobs
	// then run with DFTSTREAM_OFFLINE=1 — journaling instead of burning
	// walltime on connection timeouts — and chain a best-effort
	// `dftstream sync` after ORCA finishes, with the journal left for a
	// login-node sync when the node truly has no route. Default false.
	ComputeNodesOffline bool      `yaml:"compute_nodes_offline"`
	DefaultProfile      string    `yaml:"default_profile"`
	ArrayProfile        string    `yaml:"array_profile"`
	Profiles            []Profile `yaml:"profiles"`
}

// Scratch describes the node-local (or fast shared) filesystem the job
// runs on. ORCA writes hundreds of files per step; running on the home
// filesystem is what these scripts exist to avoid.
type Scratch struct {
	// Base is written verbatim into the script, so $USER works.
	Base   string        `yaml:"base"`
	Layout ScratchLayout `yaml:"layout"`
	// CleanGlobs are deleted in scratch before copying results back.
	CleanGlobs []string `yaml:"clean_globs"`
	// CopyBackGlobs select what returns to the job directory.
	CopyBackGlobs []string `yaml:"copy_back_globs"`
}

// StreamOptions are the `dftstream run` flags used when the job is
// tracked (the default). Both fields take any spelling `dftstream run`
// accepts (levels.ParseArtifactLevel / levels.ParseOrbitalMode) and are
// required: pointers, so an omitted key is told apart from a parsed value.
type StreamOptions struct {
	Artifacts *levels.ArtifactLevel `yaml:"artifacts"`
	Orbitals  *levels.OrbitalMode   `yaml:"orbitals"`
}

// Profile is a named queue choice: partition plus walltime, and for
// array jobs the concurrency throttle.
type Profile struct {
	Name      string `yaml:"name"`
	Partition string `yaml:"partition"`
	// OmitPartition leaves out --partition entirely (for the cluster's
	// default queue, where naming it only invites breakage on rename).
	OmitPartition bool `yaml:"omit_partition"`
	// Walltime is the --time value; empty emits no --time at all, for
	// queues that reject the request (express-style partitions).
	Walltime string `yaml:"walltime"`
	// ArrayThrottle caps concurrently running array tasks (the N in
	// --array=1-M%N). Zero means no throttle.
	ArrayThrottle int `yaml:"array_throttle"`
	// CopyBackGlobs overrides the cluster's, if set.
	CopyBackGlobs   []string `yaml:"copy_back_globs"`
	ExtraDirectives []string `yaml:"extra_directives"`
}

// LoadConfig reads a cluster config. An explicit path must exist; with
// no path it walks the search order and finally falls back to the
// built-in config.
func LoadConfig(explicit string) (Config, string, error) {
	if explicit != "" {
		cfg, err := loadConfigFrom(explicit)
		return cfg, explicit, err
	}
	for _, p := range configSearchPaths() {
		if p == "" {
			continue
		}
		if _, err := os.Stat(p); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return Config{}, p, fmt.Errorf("check %s: %w", p, err)
		}
		cfg, err := loadConfigFrom(p)
		return cfg, p, err
	}
	cfg, err := ParseConfig(defaultClustersYAML)
	return cfg, "(built-in)", err
}

func configSearchPaths() []string {
	paths := []string{os.Getenv("DFTSTREAM_CLUSTERS"), "clusters.yaml"}
	home, err := os.UserHomeDir()
	if err == nil {
		paths = append(paths, filepath.Join(home, ".config", "dftstream", "clusters.yaml"))
	}
	// No home directory is not an error here: the remaining search paths
	// and the built-in default still apply.
	return paths
}

func loadConfigFrom(path string) (Config, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("read cluster config %s: %w", path, err)
	}
	cfg, err := ParseConfig(b)
	if err != nil {
		return Config{}, fmt.Errorf("%s: %w", path, err)
	}
	return cfg, nil
}

// ParseConfig decodes and validates a cluster config. Unknown fields are
// rejected: a mistyped key would otherwise silently keep a default and
// send jobs to the wrong queue.
func ParseConfig(b []byte) (Config, error) {
	var cfg Config
	dec := yaml.NewDecoder(bytes.NewReader(b))
	dec.KnownFields(true)
	if err := dec.Decode(&cfg); err != nil {
		return Config{}, fmt.Errorf("parse cluster config: %w", err)
	}
	if err := cfg.validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (c Config) validate() error {
	if len(c.Clusters) == 0 {
		return errors.New("cluster config defines no clusters")
	}
	seen := map[string]bool{}
	for i := range c.Clusters {
		cl := &c.Clusters[i]
		if cl.Name == "" {
			return fmt.Errorf("clusters[%d]: name is required", i)
		}
		if seen[cl.Name] {
			return fmt.Errorf("cluster %q is defined twice", cl.Name)
		}
		seen[cl.Name] = true
		if err := cl.validate(); err != nil {
			return fmt.Errorf("cluster %q: %w", cl.Name, err)
		}
	}
	if c.DefaultCluster != "" && !seen[c.DefaultCluster] {
		return fmt.Errorf("default_cluster %q is not defined", c.DefaultCluster)
	}
	return nil
}

func (c *Cluster) validate() error {
	if err := validate("scheduler", c.Scheduler, schedulers); err != nil {
		return err
	}
	if err := validate("tasks_directive", c.TasksDirective, tasksDirectives); err != nil {
		return err
	}
	if err := validate("scratch.layout", c.Scratch.Layout, scratchLayouts); err != nil {
		return err
	}
	// Values were parsed (and rejected if unknown) while decoding; only
	// presence is left to check.
	if c.Stream.Artifacts == nil {
		return fmt.Errorf("stream.artifacts is required (want one of %s)", levels.ArtifactLevelHelp)
	}
	if c.Stream.Orbitals == nil {
		return fmt.Errorf("stream.orbitals is required (want one of %s)", levels.OrbitalModeHelp)
	}
	if c.OrcaBinary == "" {
		return errors.New("orca_binary is required")
	}
	if c.Scratch.Base == "" {
		return errors.New("scratch.base is required")
	}
	if len(c.Profiles) == 0 {
		return errors.New("no profiles defined")
	}
	names := map[string]bool{}
	for i, p := range c.Profiles {
		if p.Name == "" {
			return fmt.Errorf("profiles[%d]: name is required", i)
		}
		if names[p.Name] {
			return fmt.Errorf("profile %q is defined twice", p.Name)
		}
		names[p.Name] = true
	}
	for field, want := range map[string]string{
		"default_profile": c.DefaultProfile,
		"array_profile":   c.ArrayProfile,
	} {
		if want != "" && !names[want] {
			return fmt.Errorf("%s %q is not a defined profile", field, want)
		}
	}
	return nil
}

// ClusterNamed returns a cluster by name, or the configured default when
// name is empty.
func (c Config) ClusterNamed(name string) (Cluster, error) {
	if name == "" {
		name = c.DefaultCluster
	}
	if name == "" {
		return Cluster{}, errors.New("no cluster requested and no default_cluster set")
	}
	for _, cl := range c.Clusters {
		if cl.Name == name {
			return cl, nil
		}
	}
	return Cluster{}, fmt.Errorf("unknown cluster %q (have %v)", name, c.clusterNames())
}

func (c Config) clusterNames() []string {
	out := make([]string, 0, len(c.Clusters))
	for _, cl := range c.Clusters {
		out = append(out, cl.Name)
	}
	return out
}

// ProfileNamed returns a queue profile by name, or the cluster default
// when name is empty.
func (c Cluster) ProfileNamed(name string) (Profile, error) {
	if name == "" {
		name = c.DefaultProfile
	}
	if name == "" {
		return Profile{}, fmt.Errorf("cluster %q: no profile requested and no default_profile set", c.Name)
	}
	for _, p := range c.Profiles {
		if p.Name == name {
			return p, nil
		}
	}
	return Profile{}, fmt.Errorf("cluster %q: unknown profile %q (have %v)", c.Name, name, c.ProfileNames())
}

// ProfileNames lists the queue profiles a cluster offers.
func (c Cluster) ProfileNames() []string {
	out := make([]string, 0, len(c.Profiles))
	for _, p := range c.Profiles {
		out = append(out, p.Name)
	}
	return out
}

// copyBackGlobs resolves the profile override against the cluster
// default, falling back to everything.
func (c Cluster) copyBackGlobs(p Profile) []string {
	if len(p.CopyBackGlobs) > 0 {
		return p.CopyBackGlobs
	}
	if len(c.Scratch.CopyBackGlobs) > 0 {
		return c.Scratch.CopyBackGlobs
	}
	return []string{"*"}
}

// examplePathPrefix marks the template paths in clusters.default.yaml.
const examplePathPrefix = "/path/to/"

// ExamplePaths lists the binary fields that still hold a template path
// from the built-in config, so a job is never queued against
// /path/to/orca.
func (c Cluster) ExamplePaths() []string {
	var out []string
	for field, value := range map[string]string{
		"orca_binary":      c.OrcaBinary,
		"dftstream_binary": c.DFTStreamBinary,
	} {
		if strings.HasPrefix(value, examplePathPrefix) {
			out = append(out, field)
		}
	}
	sort.Strings(out)
	return out
}
