package runner

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/nkls-ai/dftstream/internal/artifacts"
	"github.com/nkls-ai/dftstream/internal/levels"
	"github.com/nkls-ai/dftstream/internal/postproc"
	"github.com/nkls-ai/dftstream/internal/restart"
)

// runPostproc invokes orca_plot for HOMO/LUMO cubes and orca_pltvib for
// imaginary modes (if either is applicable). Generated files land in
// the input file's directory so artifacts.Collect picks them up. All
// errors are logged to stderr; this never returns an error.
//
// The orbital cubes and imaginary-mode trajectories are driven by values
// parsed from ORCA's output (HOMO index, last frequency block). When the
// captured stdout overflowed its cap, only the head of the output is
// available and those values would come from an early step, not the final
// one — so both are skipped with a warning rather than rendered wrong.
func runPostproc(ctx context.Context, opts Options, stdoutCap *artifacts.CapWriter, snapDir string, snapshotCycles []int) {
	stem := DefaultRunName(opts.InputPath)
	workDir := filepath.Dir(opts.InputPath)
	orcaDir := filepath.Dir(opts.OrcaPath)
	outText, overflowed, totalBytes := stdoutCap.Snapshot()
	tools := postproc.Toolchain{}

	if overflowed {
		fmt.Fprintf(opts.Stderr, "[dftstream] orbital cubes and imag-vib trjs skipped: ORCA output (%d bytes) exceeded the %d-byte capture, so the final HOMO/frequencies are not available\n",
			totalBytes, len(outText))
	}

	if opts.OrbitalMode == levels.OrbitalsNone || overflowed {
		// Skip all cube generation; still run pltvib below.
	} else {
		cubes, err := tools.GenerateOrbitalCubes(ctx, orcaDir, workDir, stem, outText, 60*time.Second)
		if err != nil {
			fmt.Fprintf(opts.Stderr, "[dftstream] orbital cubes skipped: %v\n", err)
		} else if len(cubes) > 0 {
			names := make([]string, len(cubes))
			for i, c := range cubes {
				names[i] = filepath.Base(c.Path)
			}
			fmt.Fprintf(opts.Stderr, "[dftstream] generated orbital cubes: %s\n", strings.Join(names, ", "))
		}

		if opts.OrbitalMode == levels.OrbitalsPerCycle && snapDir != "" && len(snapshotCycles) > 0 {
			percycle, err := tools.GeneratePerCycleOrbitalCubes(
				ctx, orcaDir, snapDir, workDir, stem, outText, snapshotCycles, 5*time.Minute,
			)
			if err != nil {
				fmt.Fprintf(opts.Stderr, "[dftstream] per-cycle cubes skipped: %v\n", err)
			} else if len(percycle) > 0 {
				fmt.Fprintf(opts.Stderr, "[dftstream] generated per-cycle cubes for %d cycles (%d cube files)\n",
					len(snapshotCycles), len(percycle))
			}
		}
	}

	var imag []postproc.ImagMode
	if !overflowed {
		imag = imagModes(outText)
	}
	if len(imag) > 0 {
		vibs, err := tools.GenerateImagVibTrjs(ctx, orcaDir, workDir, stem, imag, 60*time.Second)
		if err != nil {
			fmt.Fprintf(opts.Stderr, "[dftstream] vib mode trj skipped: %v\n", err)
		} else if len(vibs) > 0 {
			names := make([]string, len(vibs))
			for i, v := range vibs {
				names[i] = filepath.Base(v.Path)
			}
			fmt.Fprintf(opts.Stderr, "[dftstream] generated imag-vib trjs: %s\n", strings.Join(names, ", "))
		}
	}

	// Intermediate Hessians (from calc_hess + recalc_hess)
	intHess := postproc.DiscoverIntermediateHessians(workDir, stem)
	if len(intHess) > 0 {
		intVibs, err := tools.GenerateIntermediateVibTrjs(ctx, orcaDir, workDir, stem, intHess, 120*time.Second)
		if err != nil {
			fmt.Fprintf(opts.Stderr, "[dftstream] intermediate hessian vibs skipped: %v\n", err)
		} else if len(intVibs) > 0 {
			fmt.Fprintf(opts.Stderr, "[dftstream] generated %d intermediate hessian vib trjs\n", len(intVibs))
		}
	}
}

// imagModes extracts the imaginary modes of the last VIBRATIONAL
// FREQUENCIES section (shared parser in internal/restart) in the shape
// postproc expects.
func imagModes(text string) []postproc.ImagMode {
	found := restart.ImagModesInLastFreqSection(text)
	out := make([]postproc.ImagMode, len(found))
	for i, m := range found {
		out[i] = postproc.ImagMode{Index: m.Index, Wavenumber: m.FreqCM}
	}
	return out
}
