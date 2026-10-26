package parser

import "strings"

// ErrorClass names why an ORCA run failed or stalled.
//
// The string values are the contract with the database: they must stay
// byte-identical to ERROR_CLASS in db/convex/schema.ts, which the UI
// groups and filters on. Adding a member here means adding it there.
type ErrorClass string

const (
	// ErrorClassSCFNotConverged: the SCF hit its iteration limit or
	// diverged, so no wavefunction (and therefore no energy) exists.
	ErrorClassSCFNotConverged ErrorClass = "scf_not_converged"
	// ErrorClassOptMaxCycles: the optimizer ran out of cycles before the
	// convergence criteria were met. Never produced by the rule table —
	// it is derived from the accumulator's optMaxCycles flag so the
	// `optMaxCycles` column and this class cannot disagree.
	ErrorClassOptMaxCycles ErrorClass = "opt_max_cycles"
	// ErrorClassOutOfMemory: %maxcore too small, or the node ran out of RAM.
	ErrorClassOutOfMemory ErrorClass = "out_of_memory"
	// ErrorClassDiskOrScratch: the scratch directory or disk failed —
	// full, over quota, or unwritable.
	ErrorClassDiskOrScratch ErrorClass = "disk_or_scratch"
	// ErrorClassGeometryExploded: the structure fell apart far enough that
	// ORCA can no longer build or convert its internal coordinates.
	ErrorClassGeometryExploded ErrorClass = "geometry_exploded"
	// ErrorClassChargeMultImpossible: the requested charge/multiplicity
	// pair cannot describe the molecule's electron count.
	ErrorClassChargeMultImpossible ErrorClass = "charge_mult_impossible"
	// ErrorClassUnstableWavefunction: the stability analysis found the
	// HF/KS solution is a saddle point (negative eigenvalues of the
	// stability matrix) and reconvergence failed.
	ErrorClassUnstableWavefunction ErrorClass = "unstable_wavefunction"
	// ErrorClassBasisOrECPMissing: no basis set or ECP for some element.
	ErrorClassBasisOrECPMissing ErrorClass = "basis_or_ecp_missing"
	// ErrorClassExternalToolFailed: an auxiliary ORCA module or external
	// program (xtb, NBO, orca_plot, …) died.
	ErrorClassExternalToolFailed ErrorClass = "external_tool_failed"
	// ErrorClassInputError: the input file was rejected.
	ErrorClassInputError ErrorClass = "input_error"
	// ErrorClassUnknown: the run failed but nothing in the output says why.
	ErrorClassUnknown ErrorClass = "unknown"
)

func (c ErrorClass) String() string { return string(c) }

// AllErrorClasses lists every class, most specific first. The order is
// the severity order used by MoreSevereThan.
var AllErrorClasses = []ErrorClass{
	ErrorClassChargeMultImpossible,
	ErrorClassBasisOrECPMissing,
	ErrorClassOutOfMemory,
	ErrorClassDiskOrScratch,
	ErrorClassUnstableWavefunction,
	ErrorClassSCFNotConverged,
	ErrorClassGeometryExploded,
	ErrorClassOptMaxCycles,
	ErrorClassExternalToolFailed,
	ErrorClassInputError,
	ErrorClassUnknown,
}

// errorClassSeverity ranks classes so a run whose output contains several
// diagnoses reports the most informative one. Lower is more severe.
//
// The ordering encodes "cause beats consequence": an out-of-memory abort
// inside LeanSCF also prints "ORCA finished by error termination in
// LEANSCF", and almost every fatal path ends in a generic "aborting the
// run", so the specific rules must outrank the generic ones.
var errorClassSeverity = func() map[ErrorClass]int {
	m := make(map[ErrorClass]int, len(AllErrorClasses))
	for i, c := range AllErrorClasses {
		m[c] = i
	}
	return m
}()

// severity returns the rank of c; an unrecognised class ranks last so a
// value from a newer wrapper never displaces a known diagnosis.
func (c ErrorClass) severity() int {
	if r, ok := errorClassSeverity[c]; ok {
		return r
	}
	return len(AllErrorClasses)
}

// MoreSevereThan reports whether c is a more informative diagnosis than
// other. The empty class (no diagnosis) is always the least severe.
func (c ErrorClass) MoreSevereThan(other ErrorClass) bool {
	if c == "" {
		return false
	}
	if other == "" {
		return true
	}
	return c.severity() < other.severity()
}

// IsHardFailure reports whether this class is a failure on its own, even
// when ORCA went on to print its "TERMINATED NORMALLY" banner.
//
// That combination is real and not rare: a module can die mid-run
// ("ORCA finished by error termination in CIS") and ORCA still closes the
// output with the normal banner and exit 0, so the run looks clean to
// anything that only greps for the banner. The classes listed here are
// ones ORCA never prints during a healthy run.
//
// The rest are context-dependent and are only reported when the run
// itself failed: ORCA prints the wavefunction-instability banner before
// reconverging, and an unconverged SCF can be deliberate (NoIter, a
// tolerated scan point).
func (c ErrorClass) IsHardFailure() bool {
	switch c {
	case ErrorClassChargeMultImpossible,
		ErrorClassBasisOrECPMissing,
		ErrorClassOutOfMemory,
		ErrorClassDiskOrScratch,
		ErrorClassExternalToolFailed:
		return true
	}
	return false
}

// diagnosticRule maps a set of landmark texts to the class they diagnose.
// A line matches the rule when it contains any of the landmarks; the
// rules are tried in severity order, so the first match wins.
type diagnosticRule struct {
	class     ErrorClass
	landmarks []string
}

// diagnosticRules is the whole classification table.
//
// ErrorClassOptMaxCycles is deliberately absent: it is raised from the
// existing lmOptNotConverged landmark in handleLandmark, next to the
// OptNotConvergedEvent that feeds the accumulator's optMaxCycles flag,
// so there is exactly one signal behind both.
var diagnosticRules = []diagnosticRule{
	{ErrorClassChargeMultImpossible, []string{
		lmMultImpossible, lmMultError, lmElectronCountEr,
	}},
	{ErrorClassBasisOrECPMissing, []string{
		lmBasisNotAssigned, lmNoBasisDefined, lmUnknownBasisName, lmECPNotAvailable,
	}},
	{ErrorClassOutOfMemory, []string{
		lmNotEnoughMemory, lmInsufficientMemory, lmPleaseIncreaseMaxCo,
		lmOutOfMemoryBanner, lmBadAlloc, lmCannotAllocate,
	}},
	{ErrorClassDiskOrScratch, []string{
		lmNoSpaceLeft, lmDiskQuotaExceeded, lmOpenForWriting,
		lmMaxBytesDisk, lmInputOutputError, lmScratchDirNotFound,
	}},
	{ErrorClassUnstableWavefunction, []string{
		lmWavefunctionUnstable, lmStillUnstable, lmStabilityNoConverge,
	}},
	{ErrorClassSCFNotConverged, []string{
		lmScfNotConvergedBanner, lmScfNotConvergedImage, lmScfHasNotConverged,
		lmScfHasDiverged, lmScfConvergenceFailure,
	}},
	{ErrorClassGeometryExploded, []string{
		lmCartToInternalFailed, lmCartToInternalError, lmInternalCoordsBroke,
	}},
	{ErrorClassExternalToolFailed, []string{
		lmErrorTermination, lmProgramReturnsErr, lmCannotBeExecuted,
	}},
	{ErrorClassInputError, []string{
		lmInputErrorBanner, lmUnrecognizedKeyword, lmAbortInputError,
		lmOrcaMainError, lmCheckYourInput,
	}},
	{ErrorClassUnknown, []string{
		lmOrcaErrorReturn,
	}},
}

// classifyLine returns the class diagnosed by one upper-cased output
// line, if any.
func classifyLine(upperLine string) (ErrorClass, bool) {
	for _, rule := range diagnosticRules {
		for _, lm := range rule.landmarks {
			if strings.Contains(upperLine, lm) {
				return rule.class, true
			}
		}
	}
	return "", false
}

// VerdictInput carries the run-level facts RunVerdict needs beyond the
// diagnostic events themselves.
type VerdictInput struct {
	// TerminatedNormally reports whether ORCA printed its "TERMINATED
	// NORMALLY" banner. When no process exit code is available (reading a
	// .out after the fact), this is the clean-run gate: on a clean run
	// only self-standing failures (IsHardFailure) count — a diagnosis the
	// run recovered from is not a failure.
	TerminatedNormally bool
	// OptStalled reports that the optimizer hit its cycle limit and never
	// converged (the OptNotConvergedEvent signal, gated on the absence of
	// a later OptConvergedEvent). It is a failure verdict even when ORCA
	// terminated normally: the final geometry is not a stationary point.
	OptStalled bool
}

// RunVerdict folds the DiagnosticEvents of one output into the single
// run-level failure class and excerpt, or ("", "") for a clean run.
//
// This is the one place the per-event diagnoses become a verdict: the
// severity tie-break, the hard-failure gate on clean runs, and the
// opt-stall override are identical to the live runner's accumulator
// (which additionally knows the process exit code). `dftstream restart`
// classifies finished outputs through this fold so the CLI and the
// tracker can never disagree about why a run died.
func RunVerdict(diags []DiagnosticEvent, in VerdictInput) (ErrorClass, string) {
	var class, hard ErrorClass
	var excerpt, hardExcerpt, optExcerpt string
	for _, d := range diags {
		if d.Class == ErrorClassOptMaxCycles {
			// Kept apart: whether a stall counts is the caller's
			// OptStalled gate, not the severity race.
			optExcerpt = d.Excerpt
			continue
		}
		if d.Class.MoreSevereThan(class) {
			class, excerpt = d.Class, d.Excerpt
		}
		if d.Class.IsHardFailure() && d.Class.MoreSevereThan(hard) {
			hard, hardExcerpt = d.Class, d.Excerpt
		}
	}
	if in.TerminatedNormally {
		class, excerpt = hard, hardExcerpt
	}
	if in.OptStalled && ErrorClassOptMaxCycles.MoreSevereThan(class) {
		class, excerpt = ErrorClassOptMaxCycles, optExcerpt
	}
	if class != "" {
		return class, excerpt
	}
	if in.TerminatedNormally {
		return "", ""
	}
	// The run died and nothing in the output says why — killed by the
	// scheduler, out of walltime, segfaulted mid-write.
	return ErrorClassUnknown, ""
}

// Excerpt sizing. The excerpt exists so a batch dashboard can show why a
// run died without opening the .out, not to reproduce the output: a few
// lines either side of the diagnosis, hard-capped so a pathological line
// (ORCA prints matrix rows thousands of characters wide) cannot bloat a
// status update.
const (
	excerptLinesBefore = 4
	excerptLinesAfter  = 3
	excerptMaxLineLen  = 200
	excerptMaxBytes    = 600
)

// diagnosticCapture is an excerpt being assembled: the lines already
// collected plus how many trailing lines are still wanted.
type diagnosticCapture struct {
	class  ErrorClass
	lines  []string
	remain int
}

// buildExcerpt joins the captured lines into the stored excerpt, dropping
// blank lines (ORCA pads its banners generously) and enforcing both the
// per-line and total caps.
func buildExcerpt(lines []string) string {
	var b strings.Builder
	for _, ln := range lines {
		ln = strings.TrimRight(ln, " \t\r")
		if strings.TrimSpace(ln) == "" {
			continue
		}
		ln = truncateRunes(ln, excerptMaxLineLen)
		if b.Len() > 0 {
			if b.Len()+1+len(ln) > excerptMaxBytes {
				break
			}
			b.WriteByte('\n')
		}
		b.WriteString(ln)
	}
	return truncateRunes(b.String(), excerptMaxBytes)
}

// truncateRunes cuts s to at most n bytes without splitting a rune. ORCA
// output is ASCII in practice, but a stray byte from a user's comment
// must not produce invalid UTF-8 in a JSON status update.
func truncateRunes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && !isRuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

func isRuneStart(b byte) bool { return b&0xC0 != 0x80 }
