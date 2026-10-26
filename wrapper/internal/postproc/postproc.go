// Package postproc runs ORCA's auxiliary tools (orca_plot, orca_pltvib)
// after the main ORCA job has finished, to produce derived artifacts
// (orbital cubes, vibrational-mode displacement xyz frames) that the UI
// can render directly. All operations are best-effort: any failure is
// reported but never blocks the main run.
package postproc

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/nkls-ai/dftstream/internal/fsutil"
	"github.com/nkls-ai/dftstream/internal/stringutil"
)

// CommandRunner abstracts spawning an ORCA aux tool so tests can inject
// a fake instead of executing real binaries (mirroring how
// tracker.Tracker is injected into the runner). Run executes bin with
// args from dir, feeding stdin, and returns the combined stdout+stderr.
type CommandRunner interface {
	Run(ctx context.Context, dir, bin string, args []string, stdin string) (string, error)
}

// execCommandRunner is the production CommandRunner backed by
// exec.CommandContext.
type execCommandRunner struct{}

func (execCommandRunner) Run(ctx context.Context, dir, bin string, args []string, stdin string) (string, error) {
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = dir
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	err := cmd.Run()
	return buf.String(), err
}

var _ CommandRunner = execCommandRunner{}

// Toolchain runs ORCA's aux tools. The zero value uses the real
// executables; tests set Exec to a fake CommandRunner.
type Toolchain struct {
	Exec CommandRunner
}

func (t Toolchain) exec() CommandRunner {
	if t.Exec != nil {
		return t.Exec
	}
	return execCommandRunner{}
}

// OrbitalResult describes a single orbital cube produced by orca_plot.
type OrbitalResult struct {
	Kind    string // "HOMO" | "LUMO" | "HOMO-1" | "LUMO+1"
	MOIndex int
	Path    string // absolute path to .cube file on disk
}

// GenerateOrbitalCubes drives orca_plot interactively against <stem>.gbw
// inside workDir to write cube files for the HOMO and LUMO orbitals.
// It is a no-op (returns nil, nil) when the gbw file is absent or HOMO
// could not be determined.
func (t Toolchain) GenerateOrbitalCubes(
	ctx context.Context,
	orcaDir, workDir, stem string,
	outText string,
	timeout time.Duration,
) ([]OrbitalResult, error) {
	gbw := filepath.Join(workDir, stem+".gbw")
	if _, err := os.Stat(gbw); err != nil {
		return nil, nil
	}
	plotBin := filepath.Join(orcaDir, "orca_plot")
	if _, err := os.Stat(plotBin); err != nil {
		return nil, nil
	}
	homo, ok := ParseHOMOFromOut(outText)
	if !ok {
		return nil, nil
	}
	lumo := homo + 1

	// orca_plot re-saves the .gbw it opens (and bakes its own working path
	// into it), which would corrupt the wavefunction file ORCA produced.
	// Run it against a throwaway copy in a scratch dir; the original .gbw is
	// never opened by the tool.
	scratch, err := os.MkdirTemp("", "dftstream-plot-")
	if err != nil {
		return nil, fmt.Errorf("orca_plot scratch: %w", err)
	}
	defer removeScratch(scratch)
	if _, err := copyInto(gbw, scratch); err != nil {
		return nil, fmt.Errorf("stage gbw for orca_plot: %w", err)
	}

	script := fmt.Sprintf("2\n%d\n11\n2\n%d\n11\n12\n", homo, lumo)
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	out, err := t.exec().Run(cctx, scratch, plotBin, []string{stem + ".gbw", "-i"}, script)
	if err != nil {
		return nil, fmt.Errorf("orca_plot: %w (output: %s)", err, stringutil.Tail(out, 400))
	}

	// Harvest the cubes out of the scratch dir into workDir so the rest of
	// the pipeline (artifact collection) finds them where it expects.
	var present []OrbitalResult
	for _, o := range []OrbitalResult{{Kind: "HOMO", MOIndex: homo}, {Kind: "LUMO", MOIndex: lumo}} {
		name := fmt.Sprintf("%s.mo%da.cube", stem, o.MOIndex)
		dst, err := harvest(filepath.Join(scratch, name), workDir)
		if err != nil {
			continue
		}
		present = append(present, OrbitalResult{Kind: o.Kind, MOIndex: o.MOIndex, Path: dst})
	}
	return present, nil
}

// GeneratePerCycleOrbitalCubes drives orca_plot once per snapshot .gbw
// (one per opt cycle). The snapshots are dftstream-made copies that the
// wrapper captured into snapDir during the run (never the user's working
// directory and never the original .gbw), so running orca_plot directly
// on them is safe. Produces cubes named <stem>.c<NNN>.mo<MO>a.cube in
// workDir, where NNN is the opt cycle and MO is the orbital index.
func (t Toolchain) GeneratePerCycleOrbitalCubes(
	ctx context.Context,
	orcaDir, snapDir, workDir, stem string,
	outText string,
	cycles []int,
	timeout time.Duration,
) ([]OrbitalResult, error) {
	if snapDir == "" {
		return nil, nil
	}
	plotBin := filepath.Join(orcaDir, "orca_plot")
	if _, err := os.Stat(plotBin); err != nil {
		return nil, nil
	}
	homo, ok := ParseHOMOFromOut(outText)
	if !ok {
		return nil, nil
	}
	lumo := homo + 1
	script := fmt.Sprintf("2\n%d\n11\n2\n%d\n11\n12\n", homo, lumo)

	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	var out []OrbitalResult
	for _, cycle := range cycles {
		snap := fmt.Sprintf("%s.c%03d", stem, cycle)
		gbw := filepath.Join(snapDir, snap+".gbw")
		if _, err := os.Stat(gbw); err != nil {
			continue
		}
		if _, err := t.exec().Run(cctx, snapDir, plotBin, []string{snap + ".gbw", "-i"}, script); err != nil {
			// Don't bail; continue with the next cycle.
			continue
		}
		for _, mo := range []int{homo, lumo} {
			kind := "HOMO"
			if mo == lumo {
				kind = "LUMO"
			}
			name := fmt.Sprintf("%s.mo%da.cube", snap, mo)
			dst, err := harvest(filepath.Join(snapDir, name), workDir)
			if err != nil {
				continue
			}
			out = append(out, OrbitalResult{
				Kind: fmt.Sprintf("%s c%d", kind, cycle), MOIndex: mo, Path: dst,
			})
		}
	}
	return out, nil
}

// VibMode describes a single imaginary vibrational mode rendered to a
// displaced-geometry xyz trj by orca_pltvib.
type VibMode struct {
	ModeIndex  int
	Wavenumber float64
	Path       string // absolute path to <stem>.v<NNN>.xyz
}

// GenerateImagVibTrjs invokes orca_pltvib on <stem>.hess for each given
// imaginary mode (mode index in ORCA's vibrational-mode numbering).
// Produces files named <stem>.v<NNN>.xyz with NNN zero-padded.
func (t Toolchain) GenerateImagVibTrjs(
	ctx context.Context,
	orcaDir, workDir, stem string,
	modes []ImagMode,
	timeout time.Duration,
) ([]VibMode, error) {
	if len(modes) == 0 {
		return nil, nil
	}
	hess := filepath.Join(workDir, stem+".hess")
	if _, err := os.Stat(hess); err != nil {
		return nil, nil
	}
	pltvibBin := filepath.Join(orcaDir, "orca_pltvib")
	if _, err := os.Stat(pltvibBin); err != nil {
		return nil, nil
	}

	// Stage the .hess into a scratch dir and run orca_pltvib there, so the
	// original ORCA .hess is never opened (and possibly rewritten) by the tool.
	scratch, err := os.MkdirTemp("", "dftstream-pltvib-")
	if err != nil {
		return nil, fmt.Errorf("orca_pltvib scratch: %w", err)
	}
	defer removeScratch(scratch)
	if _, err := copyInto(hess, scratch); err != nil {
		return nil, fmt.Errorf("stage hess for orca_pltvib: %w", err)
	}

	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	args := []string{stem + ".hess"}
	for _, m := range modes {
		args = append(args, strconv.Itoa(m.Index))
	}
	toolOut, err := t.exec().Run(cctx, scratch, pltvibBin, args, "")
	if err != nil {
		return nil, fmt.Errorf("orca_pltvib: %w (output: %s)", err, stringutil.Tail(toolOut, 400))
	}

	out := make([]VibMode, 0, len(modes))
	for _, m := range modes {
		name := fmt.Sprintf("%s.v%03d.xyz", stem, m.Index)
		dst, err := harvest(filepath.Join(scratch, name), workDir)
		if err != nil {
			continue
		}
		out = append(out, VibMode{ModeIndex: m.Index, Wavenumber: m.Wavenumber, Path: dst})
	}
	return out, nil
}

// DiscoverIntermediateHessians finds intermediate Hessian files produced
// by calc_hess + recalc_hess (e.g. stem.001.hess, stem.002.hess).
func DiscoverIntermediateHessians(workDir, stem string) []string {
	pattern1 := filepath.Join(workDir, stem+".???.hess")
	pattern2 := filepath.Join(workDir, stem+"_???.hess")
	var results []string
	for _, p := range []string{pattern1, pattern2} {
		matches, err := filepath.Glob(p)
		if err != nil {
			continue // malformed pattern — should not happen with these formats
		}
		results = append(results, matches...)
	}
	return results
}

// GenerateIntermediateVibTrjs runs orca_pltvib on each intermediate .hess
// file. Output files are named <stem>.h<NNN>.v<MMM>.xyz where NNN is the
// Hessian index and MMM is the mode index.
func (t Toolchain) GenerateIntermediateVibTrjs(
	ctx context.Context,
	orcaDir, workDir, stem string,
	hessFiles []string,
	timeout time.Duration,
) ([]VibMode, error) {
	if len(hessFiles) == 0 {
		return nil, nil
	}
	pltvibBin := filepath.Join(orcaDir, "orca_pltvib")
	if _, err := os.Stat(pltvibBin); err != nil {
		return nil, nil
	}

	// One scratch dir for the whole batch. Each intermediate .hess is staged
	// in as a copy and orca_pltvib runs there, so the originals ORCA wrote
	// are never opened by the tool.
	scratch, err := os.MkdirTemp("", "dftstream-pltvib-")
	if err != nil {
		return nil, fmt.Errorf("orca_pltvib scratch: %w", err)
	}
	defer removeScratch(scratch)

	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	var out []VibMode
	for _, hessPath := range hessFiles {
		hessBase := filepath.Base(hessPath)
		hessIdx := hessianIndex(hessBase)
		if hessIdx == "" {
			continue
		}

		if _, err := copyInto(hessPath, scratch); err != nil {
			continue
		}
		if _, err := t.exec().Run(cctx, scratch, pltvibBin, []string{hessBase}, ""); err != nil {
			continue
		}
		modes, err := harvestIntermediateVibTrjs(scratch, hessBase, workDir, stem, hessIdx)
		if err != nil {
			// One Hessian's modes are missing from the viewer; the others
			// (and the run) are unaffected, so warn and carry on.
			fmt.Fprintf(os.Stderr, "  warning: %s: %v\n", hessBase, err) //nolint:errcheck — write to stderr is best-effort
			continue
		}
		out = append(out, modes...)
	}
	return out, nil
}

// hessianIndex extracts the Hessian index from an intermediate .hess
// basename, e.g. "stem.003.hess" or "stem_003.hess" → "003". Returns ""
// when the name carries no index.
func hessianIndex(hessBase string) string {
	ext := strings.TrimSuffix(hessBase, ".hess")
	parts := strings.Split(ext, ".")
	if len(parts) >= 2 {
		return parts[len(parts)-1]
	}
	parts = strings.Split(ext, "_")
	if len(parts) >= 2 {
		return parts[len(parts)-1]
	}
	return ""
}

// harvestIntermediateVibTrjs collects the .v*.xyz files orca_pltvib
// produced in scratch for one Hessian — named <hessbase_without_ext>.
// v<NNN>.xyz — and copies them into workDir under our convention:
// <stem>.h<NNN>.v<MMM>.xyz. A mode that cannot be copied is reported and
// skipped; the error return is for when none could even be listed.
func harvestIntermediateVibTrjs(scratch, hessBase, workDir, stem, hessIdx string) ([]VibMode, error) {
	prefix := strings.TrimSuffix(hessBase, ".hess")
	pattern := filepath.Join(scratch, prefix+".v???.xyz")
	matches, err := filepath.Glob(pattern)
	if err != nil {
		// Only ErrBadPattern: the .hess name carries glob metacharacters.
		return nil, fmt.Errorf("list orca_pltvib outputs %q: %w", pattern, err)
	}
	var out []VibMode
	for _, m := range matches {
		base := filepath.Base(m)
		// Extract mode index from e.g. "stem.003.v001.xyz"
		vIdx := ""
		vParts := strings.Split(strings.TrimSuffix(base, ".xyz"), ".v")
		if len(vParts) >= 2 {
			vIdx = vParts[len(vParts)-1]
		}
		modeIdx, err := strconv.Atoi(vIdx)
		if err != nil {
			continue
		}

		newName := fmt.Sprintf("%s.h%s.v%03d.xyz", stem, hessIdx, modeIdx)
		newPath := filepath.Join(workDir, newName)
		if err := fsutil.CopyFile(m, newPath); err != nil {
			fmt.Fprintf(os.Stderr, "  warning: could not save vibrational mode %s: %v\n", newName, err) //nolint:errcheck — write to stderr is best-effort
			continue
		}
		out = append(out, VibMode{ModeIndex: modeIdx, Path: newPath})
	}
	return out, nil
}

// ImagMode is the input to GenerateImagVibTrjs.
type ImagMode struct {
	Index      int
	Wavenumber float64
}

// ParseHOMOFromOut scans the last ORBITAL ENERGIES block in text and
// returns the highest orbital index with non-zero occupation (HOMO).
// Closed-shell, RHF/RKS only — for open shell we'd want the larger of
// alpha/beta HOMOs; fine for v1.
func ParseHOMOFromOut(text string) (int, bool) {
	idx := strings.LastIndex(text, "ORBITAL ENERGIES")
	if idx < 0 {
		return 0, false
	}
	homo := -1
	sawHeader := false
	for _, line := range strings.Split(text[idx:], "\n") {
		t := strings.TrimSpace(line)
		if !sawHeader {
			if strings.HasPrefix(t, "NO") && strings.Contains(t, "OCC") {
				sawHeader = true
			}
			continue
		}
		if t == "" || strings.HasPrefix(t, "*") || strings.HasPrefix(t, "-") {
			continue
		}
		fields := strings.Fields(t)
		if len(fields) < 4 {
			break
		}
		no, errA := strconv.Atoi(fields[0])
		occ, errB := strconv.ParseFloat(fields[1], 64)
		if errA != nil || errB != nil {
			break
		}
		if occ > 0.5 {
			if no > homo {
				homo = no
			}
		}
	}
	if homo < 0 {
		return 0, false
	}
	return homo, true
}

// copyInto copies srcPath into dstDir, keeping its basename, and returns
// the destination path. Used to stage ORCA output into a scratch dir so the
// aux tools — which re-save the files they open — never touch the originals.
func copyInto(srcPath, dstDir string) (string, error) {
	dst := filepath.Join(dstDir, filepath.Base(srcPath))
	if err := fsutil.CopyFile(srcPath, dst); err != nil {
		return "", err
	}
	return dst, nil
}

// harvest copies a tool-produced file out of a scratch dir into dstDir,
// keeping its basename, and returns the destination path. Returns an error
// (skip signal for callers) if the expected file was not produced.
func harvest(srcPath, dstDir string) (string, error) {
	if _, err := os.Stat(srcPath); err != nil {
		return "", err
	}
	dst := filepath.Join(dstDir, filepath.Base(srcPath))
	if err := fsutil.CopyFile(srcPath, dst); err != nil {
		return "", err
	}
	return dst, nil
}

// removeScratch deletes a scratch dir, logging (never failing) on error —
// leftover scratch is harmless and the main run already succeeded.
func removeScratch(dir string) {
	if err := os.RemoveAll(dir); err != nil {
		fmt.Fprintf(os.Stderr, "  warning: could not remove scratch %s: %v\n", dir, err) //nolint:errcheck — write to stderr is best-effort
	}
}
