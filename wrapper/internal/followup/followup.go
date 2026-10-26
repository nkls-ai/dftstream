// Package followup generates the next input of the standard TS workflow
// from finished runs:
//
//	neb-ts        optimized reactant + product → NEB-TS search input
//	irc           validated TS → IRC (both directions), reusing the .hess
//	opt-endpoints IRC → Opt Freq inputs for both endpoint structures
//	sp            any stationary point → high-level single point
//
// Source files are only ever read; every generated input is a new file.
// Generated inputs carry a provenance comment
// (`# dftstream: edge=<kind> parent="<experiment>/<run>"`) so the
// wrapper can link the follow-up run to its parent at submit time.
package followup

import (
	"fmt"
	"os"
	"strings"

	"github.com/nkls-ai/dftstream/internal/inputbuild"
	"github.com/nkls-ai/dftstream/internal/inputparse"
	"github.com/nkls-ai/dftstream/internal/restart"
	"github.com/nkls-ai/dftstream/internal/runner"
)

// Source is one analyzed parent run.
type Source struct {
	// OutPath is the path to the parent's .out; Stem is OutPath without
	// its extension (sibling files are found as Stem+suffix).
	OutPath  string
	Stem     string
	Summary  inputparse.Summary
	Analysis restart.Analysis
}

// OutputFile is one generated file, path suggested next to the source.
type OutputFile struct {
	Path    string
	Content string
}

// Request carries the per-command knobs.
type Request struct {
	Sources []Source
	NImages int    // neb-ts: number of NEB images
	Method  string // sp: the full '!' keyword line (without the '!')
	Force   bool   // override the validation refusals
}

// Result is a generator's output: the files to write plus non-fatal
// warnings for the caller to surface.
type Result struct {
	Files    []OutputFile
	Warnings []string
}

// Generator produces one kind of follow-up input.
type Generator interface {
	Name() string
	// NumSources reports how many parent .out files the generator needs.
	NumSources() int
	// Usage is the one-line argument synopsis shown in help output.
	Usage() string
	Generate(req Request) (Result, error)
}

// Registry maps subcommand → generator. Order for help output is in Names.
var Registry = map[string]Generator{
	"neb-ts":        nebTSGenerator{},
	"irc":           ircGenerator{},
	"opt-endpoints": optEndpointsGenerator{},
	"sp":            spGenerator{},
}

// Names lists the registry keys in help order.
var Names = []string{"neb-ts", "irc", "opt-endpoints", "sp"}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// provenance renders the parent-link comment. Experiment/run names use the
// same defaults `dftstream run` derives from the input path, so the
// wrapper can resolve them back to a run id at submit time.
func provenance(kind string, src Source) string {
	inp := src.Stem + ".inp"
	return inputparse.Provenance{
		Edge:      kind,
		ParentExp: runner.DefaultExperimentName(inp),
		ParentRun: runner.DefaultRunName(inp),
	}.Comment()
}

func requireConverged(src Source, force bool) error {
	if len(src.Analysis.LastGeometry) == 0 {
		return fmt.Errorf("%s: no geometry found in the output", src.OutPath)
	}
	conv := src.Analysis.OptConverged
	if src.Summary.RequestsNEBBand() {
		conv = src.Analysis.OptConvergedPostNEB
	}
	if !conv && src.Summary.RequestsOptimization() && !force {
		return fmt.Errorf("%s: the optimization never converged — restart it first (or pass -f to use the last geometry anyway)", src.OutPath)
	}
	return nil
}

// sameSystem checks the two sources describe the same atoms in the same
// order — the hard requirement for a NEB between them.
func sameSystem(a, b Source) error {
	ga, gb := a.Analysis.LastGeometry, b.Analysis.LastGeometry
	if len(ga) != len(gb) {
		return fmt.Errorf("atom count differs: %d in %s vs %d in %s", len(ga), a.OutPath, len(gb), b.OutPath)
	}
	for i := range ga {
		if !strings.EqualFold(ga[i].El, gb[i].El) {
			return fmt.Errorf("element sequence differs at atom %d: %s vs %s — NEB endpoints must share identical atom ordering", i+1, ga[i].El, gb[i].El)
		}
	}
	ca, cb := chargeMult(a.Summary), chargeMult(b.Summary)
	if ca != cb {
		return fmt.Errorf("charge/multiplicity differ: %s vs %s", ca, cb)
	}
	return nil
}

func chargeMult(s inputparse.Summary) string {
	c, m := 0, 1
	if s.Charge != nil {
		c = *s.Charge
	}
	if s.Mult != nil {
		m = *s.Mult
	}
	return fmt.Sprintf("%d %d", c, m)
}

func methodLabel(s inputparse.Summary) string {
	parts := []string{}
	if s.Functional != "" {
		parts = append(parts, s.Functional)
	} else if s.Method != "" {
		parts = append(parts, s.Method)
	}
	if s.Basis != "" {
		parts = append(parts, s.Basis)
	}
	return strings.Join(parts, "/")
}

// xyzFrames reads every complete frame of a (possibly multi-frame) xyz
// trajectory file; truncated trailing frames are dropped.
func xyzFrames(path string) ([][]restart.Atom, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	lines := strings.Split(strings.ReplaceAll(string(raw), "\r\n", "\n"), "\n")
	var frames [][]restart.Atom
	for i := 0; i < len(lines); {
		var n int
		if _, err := fmt.Sscanf(strings.TrimSpace(lines[i]), "%d", &n); err != nil || n <= 0 {
			i++
			continue
		}
		if i+2+n > len(lines) {
			break // truncated trailing frame
		}
		var atoms []restart.Atom
		ok := true
		for j := i + 2; j < i+2+n; j++ {
			var at restart.Atom
			if _, err := fmt.Sscanf(lines[j], "%s %f %f %f", &at.El, &at.X, &at.Y, &at.Z); err != nil {
				ok = false
				break
			}
			atoms = append(atoms, at)
		}
		if ok && len(atoms) == n {
			frames = append(frames, atoms)
		}
		i += 2 + n
	}
	if len(frames) == 0 {
		return nil, fmt.Errorf("%s: no complete xyz frame found", path)
	}
	return frames, nil
}

// lastXYZFrame reads the final complete frame of an xyz trajectory.
func lastXYZFrame(path string) ([]restart.Atom, error) {
	frames, err := xyzFrames(path)
	if err != nil {
		return nil, err
	}
	return frames[len(frames)-1], nil
}

// newInput seeds the typed input for a follow-up: the provenance
// comment plus the parent's environment (charge / multiplicity /
// solvation) and resources. The caller sets Structure.
func newInput(kind string, src Source, keywords []string, blocks ...inputbuild.Block) inputbuild.Input {
	env, res := inputbuild.FromSummary(src.Summary)
	return inputbuild.Input{
		Comments: []string{provenance(kind, src)},
		Keywords: keywords,
		Env:      env,
		Res:      res,
		Blocks:   blocks,
	}
}

// buildInput renders a follow-up input around an inline geometry.
func buildInput(kind string, src Source, keywords []string, geom []restart.Atom, blocks ...inputbuild.Block) string {
	in := newInput(kind, src, keywords, blocks...)
	in.Structure = inputbuild.Geometry(geom)
	return in.Render()
}
