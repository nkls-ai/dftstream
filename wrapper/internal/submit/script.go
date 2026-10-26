package submit

import (
	"fmt"
	"strings"
)

// scriptBuilder accumulates shell lines.
type scriptBuilder struct{ b strings.Builder }

// line appends a literal shell line; linef appends a formatted one.
func (s *scriptBuilder) line(text string) {
	s.b.WriteString(text)
	s.b.WriteByte('\n')
}

func (s *scriptBuilder) linef(format string, args ...any) {
	fmt.Fprintf(&s.b, format, args...)
	s.b.WriteByte('\n')
}

func (s *scriptBuilder) blank()         { s.b.WriteByte('\n') }
func (s *scriptBuilder) String() string { return s.b.String() }

// directives writes the #SBATCH header shared by single and array jobs.
func (s *scriptBuilder) directives(c Cluster, p Profile, name string, res Resources, extra []string, logStem string) {
	s.line("#!/bin/bash")
	s.blank()
	s.linef("#SBATCH --job-name=%s", name)
	if !p.OmitPartition && p.Partition != "" {
		s.linef("#SBATCH --partition=%s", p.Partition)
	}
	for _, d := range extra {
		s.linef("#SBATCH %s", d)
	}
	s.line("#SBATCH --nodes=1")
	s.linef("#SBATCH --%s=%d", c.TasksDirective.Flag(), res.Threads)
	// Unit-suffixed on purpose: a bare --mem=N means megabytes to SLURM,
	// so an unsuffixed gigabyte figure asks for a thousandth of the
	// memory the input wants.
	s.linef("#SBATCH --mem=%dG", res.MemoryGB)
	if p.Walltime != "" {
		s.linef("#SBATCH --time=%s", p.Walltime)
	}
	for _, d := range p.ExtraDirectives {
		s.linef("#SBATCH %s", d)
	}
	s.linef("#SBATCH --error=%s.err", logStem)
	s.linef("#SBATCH --output=%s.log", logStem)
	s.blank()
	s.environment(c)
}

func (s *scriptBuilder) environment(c Cluster) {
	wrote := false
	for _, m := range c.Modules {
		// A config entry may name several modules ("chem orca/6.0.1"),
		// so quote per field rather than per entry; shQuote keeps plain
		// names bare and defuses shell syntax in hostile ones.
		fields := strings.Fields(m)
		if len(fields) == 0 {
			continue
		}
		s.linef("module load %s", strings.Join(quoteAll(fields), " "))
		wrote = true
	}
	for _, k := range sortedKeys(c.Env) {
		s.linef("export %s=%s", k, shQuote(c.Env[k]))
		wrote = true
	}
	if wrote {
		s.blank()
	}
}

// scratchAndCleanup emits the scratch handling: the copy-back helper, the
// cleanup trap, and the move into scratch.
//
// The copy-back runs from a trap rather than as trailing lines because a
// job killed at the walltime never reaches its trailing lines — and a
// 24-hour optimization that dies one minute past the limit still holds
// every geometry step it managed. The trap gets those back.
func (s *scriptBuilder) scratchAndCleanup(c Cluster, p Profile) {
	// Patterns reach these helpers quoted and are expanded inside, with
	// scratch as the working directory.
	s.line(`copy_back() {`)
	s.line(`    local pat f`)
	s.line(`    for pat in "$@"; do`)
	s.line(`        for f in $pat; do`)
	s.line(`            [ -e "$f" ] || continue`)
	s.line(`            cp -r "$f" "$SOURCE"/ || echo "copy back failed: $f" >&2`)
	s.line(`        done`)
	s.line(`    done`)
	s.line(`}`)
	s.blank()
	if len(c.Scratch.CleanGlobs) > 0 {
		s.line(`clean_scratch() {`)
		s.line(`    local pat f`)
		s.line(`    for pat in "$@"; do`)
		s.line(`        for f in $pat; do`)
		s.line(`            [ -e "$f" ] && rm -rf "$f"`)
		s.line(`        done`)
		s.line(`    done`)
		s.line(`}`)
		s.blank()
	}
	s.line(`_cleaned=0`)
	s.line(`cleanup() {`)
	s.line(`    [ "$_cleaned" = 1 ] && return`)
	s.line(`    _cleaned=1`)
	s.line(`    cd "$TMP" || return`)
	if globs := c.Scratch.CleanGlobs; len(globs) > 0 {
		s.linef(`    clean_scratch %s`, shQuoteAll(globs))
	}
	s.linef(`    copy_back %s`, shQuoteAll(c.copyBackGlobs(p)))
	s.line(`    cd "$SOURCE" || return`)
	s.line(`    rm -rf "$TMP"`)
	// Tidy the per-name scratch parent too; it fails harmlessly while
	// another job of the same name is still using it.
	s.line(`    rmdir "$(dirname "$TMP")" 2>/dev/null`)
	s.line(`}`)
	s.line(`trap cleanup EXIT TERM INT`)
	s.blank()
}

// orcaCommand renders the line that runs the calculation.
//
// inputExpr and outExpr are finished shell WORDS, already quoted by the
// caller: a single job passes shQuote of a literal filename, an array
// task passes `"$INPUT"`. They are interpolated verbatim, so a caller
// that forgets to quote hands a filename straight to the shell.
func orcaCommand(c Cluster, inputExpr, outExpr, experiment string, stream bool) string {
	var parts []string
	if stream {
		parts = append(parts, shQuote(dftstreamBin(c)), "run",
			"-artifacts", c.Stream.Artifacts.String(),
			"-orbitals", c.Stream.Orbitals.String())
		if experiment != "" {
			parts = append(parts, "-exp", shQuote(experiment))
		}
		parts = append(parts, "-orca", shQuote(c.OrcaBinary), inputExpr)
		if len(c.OrcaArgs) > 0 {
			parts = append(parts, "--")
			parts = append(parts, quoteAll(c.OrcaArgs)...)
		}
	} else {
		parts = append(parts, shQuote(c.OrcaBinary), inputExpr)
		parts = append(parts, quoteAll(c.OrcaArgs)...)
	}
	parts = append(parts, ">", outExpr)
	return strings.Join(parts, " ")
}

// dftstreamBin is the wrapper binary the generated script invokes.
func dftstreamBin(c Cluster) string {
	if c.DFTStreamBinary != "" {
		return c.DFTStreamBinary
	}
	return "dftstream"
}

// emitOrcaCommand writes the calculation line. On clusters whose compute
// nodes cannot reach the backend (compute_nodes_offline: true), a streamed
// job additionally: (a) exports DFTSTREAM_OFFLINE=1 so the wrapper journals
// immediately instead of spending walltime on connection timeouts, and
// (b) chains a best-effort `dftstream sync` after ORCA — it uploads the
// journal right away if the node has a route after all, and otherwise leaves
// it for `dftstream sync` on a login node. ORCA's exit code is preserved as
// the job's exit code either way.
func (s *scriptBuilder) emitOrcaCommand(c Cluster, cmdLine string, stream bool) {
	if !stream || !c.ComputeNodesOffline {
		s.linef("%s", cmdLine)
		return
	}
	s.line(`# Compute nodes on this cluster cannot reach the tracker; journal`)
	s.line(`# tracking data locally (synced to the backend after the job).`)
	s.line(`export DFTSTREAM_OFFLINE=1`)
	s.linef("%s", cmdLine)
	s.line(`ORCA_EXIT=$?`)
	s.blank()
	s.line(`# Best-effort upload; on a truly offline node this fails fast and the`)
	s.line(`# journal stays put for a login-node sync.`)
	s.linef(`%s sync || echo "[dftstream] sync deferred - run 'dftstream sync' from a login node" >&2`, shQuote(dftstreamBin(c)))
	s.line(`exit "$ORCA_EXIT"`)
}

// scratchPath renders the scratch directory expression for a single job.
//
// Only the job name is quoted. The configured base is left raw on
// purpose — an operator writes `/scratch/tmp/$USER` and expects the
// variable to expand — while the name is a filename stem the wrapper
// derived from an .inp. Unquoted, "benzene opt.inp" emitted
// `TMP=/scratch/benzene opt/$SLURM_JOB_ID`, which bash reads as a one-off
// assignment in front of the command `opt/$SLURM_JOB_ID`, leaving TMP
// empty for the rest of the script; a name carrying `$(...)` ran.
func scratchPath(c Cluster, name string) string {
	base := strings.TrimRight(c.Scratch.Base, "/")
	if c.Scratch.Layout == ScratchNameJobID {
		return fmt.Sprintf("%s/%s/$SLURM_JOB_ID", base, shQuote(name))
	}
	return base + "/$SLURM_JOB_ID"
}

// arrayScratchPath keeps array tasks on the same node from colliding:
// every task of one array shares $SLURM_JOB_ID.
func arrayScratchPath(c Cluster, name string) string {
	base := strings.TrimRight(c.Scratch.Base, "/")
	if c.Scratch.Layout == ScratchNameJobID {
		return fmt.Sprintf("%s/%s/${SLURM_JOB_ID}_${SLURM_ARRAY_TASK_ID}", base, shQuote(name))
	}
	return base + "/${SLURM_JOB_ID}_${SLURM_ARRAY_TASK_ID}"
}
