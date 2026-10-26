package followup

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/nkls-ai/dftstream/internal/inputbuild"
)

// ---------------------------------------------------------------------------
// neb-ts: optimized reactant + product → NEB-TS input
// ---------------------------------------------------------------------------

type nebTSGenerator struct{}

func (nebTSGenerator) Name() string    { return "neb-ts" }
func (nebTSGenerator) NumSources() int { return 2 }
func (nebTSGenerator) Usage() string {
	return "neb-ts <reactant.out> <product.out> [-nimages N]   NEB-TS search between two optimized minima"
}

func (g nebTSGenerator) Generate(req Request) (Result, error) {
	reactant, product := req.Sources[0], req.Sources[1]
	for _, src := range req.Sources {
		if err := requireConverged(src, req.Force); err != nil {
			return Result{}, err
		}
	}
	if err := sameSystem(reactant, product); err != nil {
		return Result{}, err
	}
	var warns []string
	if mr, mp := methodLabel(reactant.Summary), methodLabel(product.Summary); mr != mp {
		warns = append(warns, fmt.Sprintf("reactant and product were optimized at different levels (%s vs %s) — the NEB inherits the reactant's method", mr, mp))
	}

	// Both endpoints go into their own .xyz: ORCA's NEB aborts looking for
	// per-image GBW files when the starting structure is inline.
	reactantXYZ := reactant.Stem + "_neb-ts_reactant.xyz"
	productXYZ := reactant.Stem + "_neb-ts_product.xyz"
	in := newInput("neb-ts", reactant,
		inputbuild.KeywordsFor(reactant.Summary.Keywords, inputbuild.JobNEBTSFreq),
		inputbuild.NEBBlock{
			EndXYZFile: filepath.Base(productXYZ),
			NImages:    req.NImages, // ≤ 0 falls back to the band default
		})
	in.Structure = inputbuild.XYZFile(filepath.Base(reactantXYZ))

	return Result{
		Files: []OutputFile{
			{Path: reactant.Stem + "_neb-ts.inp", Content: in.Render()},
			{Path: reactantXYZ, Content: inputbuild.XYZFileText("reactant endpoint, from "+filepath.Base(reactant.OutPath), reactant.Analysis.LastGeometry)},
			{Path: productXYZ, Content: inputbuild.XYZFileText("product endpoint, from "+filepath.Base(product.OutPath), product.Analysis.LastGeometry)},
		},
		Warnings: warns,
	}, nil
}

// ---------------------------------------------------------------------------
// irc: validated TS → IRC input (reusing the .hess when present)
// ---------------------------------------------------------------------------

type ircGenerator struct{}

func (ircGenerator) Name() string    { return "irc" }
func (ircGenerator) NumSources() int { return 1 }
func (ircGenerator) Usage() string {
	return "irc <ts.out>                                        IRC (both directions) from a validated TS"
}

func (g ircGenerator) Generate(req Request) (Result, error) {
	src := req.Sources[0]
	if err := requireConverged(src, req.Force); err != nil {
		return Result{}, err
	}
	if n := len(src.Analysis.ImagModes); n != 1 && !req.Force {
		return Result{}, fmt.Errorf("%s: %d imaginary modes, a validated TS needs exactly 1 — an IRC from this geometry is meaningless (pass -f to generate anyway)", src.OutPath, n)
	}

	var blocks []inputbuild.Block
	var warns []string
	if hess := src.Stem + ".hess"; fileExists(hess) {
		blocks = append(blocks, inputbuild.IRCBlock{HessFilename: filepath.Base(hess)})
	} else {
		warns = append(warns, "no sibling .hess found — ORCA will compute a fresh Hessian before the IRC (expensive); rerun the TS with Freq to produce one")
	}

	input := buildInput("irc", src,
		inputbuild.KeywordsFor(src.Summary.Keywords, inputbuild.JobIRC),
		src.Analysis.LastGeometry, blocks...)
	return Result{
		Files:    []OutputFile{{Path: src.Stem + "_irc.inp", Content: input}},
		Warnings: warns,
	}, nil
}

// ---------------------------------------------------------------------------
// opt-endpoints: IRC → Opt Freq inputs for both endpoints
// ---------------------------------------------------------------------------

type optEndpointsGenerator struct{}

func (optEndpointsGenerator) Name() string    { return "opt-endpoints" }
func (optEndpointsGenerator) NumSources() int { return 1 }
func (optEndpointsGenerator) Usage() string {
	return "opt-endpoints <irc.out>                             Opt Freq for both IRC endpoint structures"
}

func (g optEndpointsGenerator) Generate(req Request) (Result, error) {
	src := req.Sources[0]
	kws := inputbuild.KeywordsFor(src.Summary.Keywords, inputbuild.JobOptFreq)

	var files []OutputFile
	var missing []string
	for _, dir := range []struct{ tag, suffix string }{
		{"f", "_IRC_F_trj.xyz"},
		{"b", "_IRC_B_trj.xyz"},
	} {
		trj := src.Stem + dir.suffix
		if !fileExists(trj) {
			missing = append(missing, filepath.Base(trj))
			continue
		}
		geom, err := lastXYZFrame(trj)
		if err != nil {
			return Result{}, err
		}
		files = append(files, OutputFile{
			Path:    fmt.Sprintf("%s_irc_%s_opt.inp", src.Stem, dir.tag),
			Content: buildInput("endpoint-opt", src, kws, geom),
		})
	}
	var warns []string
	if len(files) == 0 {
		// Per-direction files gone (cleaned up, or only the combined
		// trajectory was kept) — the Full trajectory runs endpoint to
		// endpoint, so its first and last frames are the two minima.
		full := src.Stem + "_IRC_Full_trj.xyz"
		if !fileExists(full) {
			return Result{}, fmt.Errorf("no IRC trajectory files (%s or %s) next to %s — did the IRC run finish?",
				strings.Join(missing, ", "), filepath.Base(full), src.OutPath)
		}
		frames, err := xyzFrames(full)
		if err != nil {
			return Result{}, err
		}
		if len(frames) < 2 {
			return Result{}, fmt.Errorf("%s: only %d frame(s) — cannot extract two endpoints", full, len(frames))
		}
		warns = append(warns, "per-direction trajectories missing — endpoints taken from the first/last frame of "+filepath.Base(full))
		for _, ep := range []struct {
			tag  string
			geom []inputbuild.Atom
		}{
			{"ep1", frames[0]},
			{"ep2", frames[len(frames)-1]},
		} {
			files = append(files, OutputFile{
				Path:    fmt.Sprintf("%s_irc_%s_opt.inp", src.Stem, ep.tag),
				Content: buildInput("endpoint-opt", src, kws, ep.geom),
			})
		}
	} else if len(missing) > 0 {
		warns = append(warns, "missing "+strings.Join(missing, ", ")+" — generated only the direction(s) found")
	}
	return Result{Files: files, Warnings: warns}, nil
}

// ---------------------------------------------------------------------------
// sp: stationary point → high-level single point
// ---------------------------------------------------------------------------

type spGenerator struct{}

func (spGenerator) Name() string    { return "sp" }
func (spGenerator) NumSources() int { return 1 }
func (spGenerator) Usage() string {
	return "sp <run.out> [-method \"! ...\"]                      high-level single point on the final geometry"
}

func (g spGenerator) Generate(req Request) (Result, error) {
	src := req.Sources[0]
	if err := requireConverged(src, req.Force); err != nil {
		return Result{}, err
	}
	method := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(req.Method), "!"))
	if method == "" {
		return Result{}, fmt.Errorf("no method for the single point — pass -method \"DLPNO-CCSD(T) cc-pVTZ ...\" or set spMethod in the dftstream config file")
	}

	// The method line replaces the source's; carry the solvent call over
	// so gas-phase SPs on solvated geometries don't happen by accident.
	kws := strings.Fields(method)
	var warns []string
	env, _ := inputbuild.FromSummary(src.Summary)
	if sol := env.SolventKeyword(); sol != "" && !inputbuild.HasSolventCall(kws) {
		kws = append(kws, sol)
		warns = append(warns, "carried the parent's solvent model over: "+sol)
	}

	input := buildInput("sp", src, kws, src.Analysis.LastGeometry)
	return Result{
		Files:    []OutputFile{{Path: src.Stem + "_sp.inp", Content: input}},
		Warnings: warns,
	}, nil
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
