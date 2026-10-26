// Package inputparse extracts a structured summary from an ORCA input
// file: the simple-input ('!') keywords, the %pal block, %maxcore, and
// derives convenience fields (functional / basis / runTypes / solvent /
// scfTier / corrections) used to label and group runs.
//
// The classifier favors recall: anything that doesn't match a known
// category still goes into Keywords so the UI can show it. ORCA accepts
// keywords case-insensitively; this package upper-cases all comparisons.
package inputparse

import (
	"math"
	"regexp"
	"strings"
)

// Summary is the structured view of one ORCA input.
type Summary struct {
	Keywords     []string  // every '!' token, preserving original casing
	Functional   string    // e.g. "wB97X-V", "r2SCAN-3c"
	Basis        string    // e.g. "def2-QZVPP"; empty for composites
	Method       string    // HF / DFT / MP2 / CCSD / DLPNO-CCSD(T) / composite
	RunTypes     []RunType // OPT, FREQ, OPTTS, SP, NUMFREQ, NEB-TS, IRC, SCAN
	ScfTier      string    // TIGHTSCF, VERYTIGHTSCF, …
	OptTier      string    // TIGHTOPT, VERYTIGHTOPT, LOOSEOPT
	Grid         string    // DEFGRID1 / DEFGRID2 / DEFGRID3
	Solvent      string    // e.g. "Acetonitrile" (from CPCM/SMD/ALPB)
	SolventModel string    // CPCM / SMD / ALPB
	Corrections  []string  // D3BJ, D4, GCP, NL …
	NProcs       int
	MaxCoreMB    int
	Charge       *int    // total molecular charge (nil if not parsed)
	Mult         *int    // spin multiplicity (nil if not parsed)
	JobType      JobType // short label derived from RunTypes for back-compat
}

// Parse reads an ORCA input file's text and returns the Summary.
func Parse(text string) Summary {
	s := Summary{Keywords: collectBangTokens(text)}
	s.classifyKeywords()
	s.applyResourceBlocks(text)
	s.applyChargeMult(text)
	s.applyImpliedOpt()
	s.applyDefaultSP()
	s.JobType = deriveJobType(s.RunTypes)
	return s
}

// applyDefaultSP labels inputs with no explicit run-type keyword as
// single-point: that is ORCA's own default (`! B3LYP def2-SVP` runs an
// SP), and without it those runs carried an empty job type and showed as
// "-" everywhere. Only applies when there is a '!' line at all, so a
// non-input (empty text) stays unlabeled.
func (s *Summary) applyDefaultSP() {
	if len(s.RunTypes) == 0 && len(s.Keywords) > 0 {
		s.RunTypes = append(s.RunTypes, RunTypeSP)
	}
}

// classifyKeywords buckets every '!' token into the Summary's typed
// fields (run types, tiers, corrections, method, basis, functional, …).
func (s *Summary) classifyKeywords() {
	seenRun := map[RunType]bool{}
	seenCorr := map[string]bool{}
	for _, tok := range s.Keywords {
		s.classifyKeyword(tok, seenRun, seenCorr)
	}

	// Default-classify when nothing matched: ORCA's own default is HF
	// when the user types only a basis set. Don't override an already-
	// detected tight-binding / wf method.
	if s.Functional == "" && s.Method == "" {
		s.Method = "HF"
	}
}

// classifyKeyword assigns one token to the first matching category; the
// order of the checks encodes precedence and must not be reshuffled.
func (s *Summary) classifyKeyword(tok string, seenRun map[RunType]bool, seenCorr map[string]bool) {
	up := strings.ToUpper(tok)

	// Solvent: CPCM(WATER), SMD(Acetonitrile), ALPB(thf) …
	if m := reSolventCall.FindStringSubmatch(tok); m != nil {
		s.SolventModel = strings.ToUpper(m[1])
		s.Solvent = m[2]
		return
	}

	// PALn shorthand → nprocs.
	if m := rePalShort.FindStringSubmatch(up); m != nil {
		n := atoi(m[1])
		if n > 0 && s.NProcs == 0 {
			s.NProcs = n
		}
		return
	}

	if runType, ok := normalizeRunType(up); ok && !seenRun[runType] {
		seenRun[runType] = true
		s.RunTypes = append(s.RunTypes, runType)
		return
	}
	if scfTierSet[up] {
		s.ScfTier = up
		return
	}
	if optTierSet[up] {
		s.OptTier = up
		return
	}
	if gridSet[up] {
		s.Grid = up
		return
	}
	if correctionSet[up] && !seenCorr[up] {
		seenCorr[up] = true
		s.Corrections = append(s.Corrections, up)
		return
	}
	// Spin / method modifiers that don't change classification but
	// shouldn't be treated as the functional.
	if spinTagSet[up] {
		return
	}
	// Composite methods (e.g. r2SCAN-3c, B97-3c, PBEh-3c, HF-3c).
	if isComposite(up) {
		s.Functional = tok
		s.Method = "composite"
		return
	}
	// Wave-function methods.
	if wfMethodSet[up] {
		s.Method = up
		return
	}
	// Semi-empirical / tight-binding methods (XTB, GFNn-xTB, PMx).
	// These don't take a separate basis / functional, so flag the
	// method and skip further classification.
	if tightBindingSet[up] {
		s.Method = up
		return
	}
	// Basis sets.
	if isBasis(up) {
		s.Basis = tok
		return
	}
	// DFT functional (last-resort guess).
	if looksLikeFunctional(up) {
		s.Functional = tok
		if s.Method == "" {
			s.Method = "DFT"
		}
	}
}

// applyResourceBlocks fills nprocs/maxcore from %block syntax when the
// '!' keywords didn't already provide them.
func (s *Summary) applyResourceBlocks(text string) {
	if s.NProcs == 0 {
		if n := extractFromBlock(text, "pal", reBlockNProcs); n > 0 {
			s.NProcs = n
		}
	}
	if s.NProcs == 0 {
		// Legacy single-line: %pal nprocs N end
		if m := reInlineNProcs.FindStringSubmatch(text); m != nil {
			s.NProcs = atoi(m[1])
		}
	}
	if s.MaxCoreMB == 0 {
		if m := reMaxcore.FindStringSubmatch(text); m != nil {
			s.MaxCoreMB = atoi(m[1])
		}
	}
}

func (s *Summary) applyChargeMult(text string) {
	if c, m, ok := parseChargeMult(text); ok {
		s.Charge = &c
		s.Mult = &m
	}
}

// applyImpliedOpt adds OPT for opt-tier keywords, which are standalone
// run keywords in ORCA: `! TightOpt` runs a geometry optimization with
// tight criteria even without an explicit `Opt`. If no geometry-driving
// run type is present, the tier implies OPT — otherwise the job would be
// misclassified as single-point and its convergence judged on SCF alone.
func (s *Summary) applyImpliedOpt() {
	if s.OptTier != "" && !hasGeometryDriver(s.RunTypes) {
		s.RunTypes = append(s.RunTypes, RunTypeOpt)
	}
}

// parseChargeMult finds the molecule-spec line (`* xyz CHARGE MULT`,
// `* xyzfile CHARGE MULT file`, `* gzmt CHARGE MULT`) or the equivalent
// %coords block fields and extracts the integer charge + multiplicity.
func parseChargeMult(text string) (int, int, bool) {
	if m := reStarCoords.FindStringSubmatch(text); m != nil {
		return atoiSigned(m[2]), atoi(m[3]), true
	}
	if cm := reBlockCharge.FindStringSubmatch(text); cm != nil {
		if mm := reBlockMult.FindStringSubmatch(text); mm != nil {
			return atoiSigned(cm[1]), atoi(mm[1]), true
		}
	}
	return 0, 0, false
}

func atoiSigned(s string) int {
	if s == "" {
		return 0
	}
	neg := false
	i := 0
	if s[0] == '-' {
		neg = true
		i = 1
	} else if s[0] == '+' {
		i = 1
	}
	n := 0
	for ; i < len(s); i++ {
		c := s[i]
		if c < '0' || c > '9' {
			break
		}
		n = n*10 + int(c-'0')
	}
	if neg {
		return -n
	}
	return n
}

// genericJobTokens are the run types that only qualify a job rather than
// naming it: "! NEB-TS Freq" is a NEB-TS job, not a FREQ job.
var genericJobTokens = map[RunType]bool{
	RunTypeOpt:     true,
	RunTypeCOpt:    true,
	RunTypeOptTS:   true,
	RunTypeFreq:    true,
	RunTypeNumFreq: true,
	RunTypeAnFreq:  true,
}

func deriveJobType(rt []RunType) JobType {
	if len(rt) == 0 {
		return ""
	}
	// A workflow run type (NEB family, IRC, SCAN, GOAT, …) is the job's
	// identity, whatever generic Opt/Freq tokens accompany it.
	for _, t := range rt {
		if !genericJobTokens[t] {
			return JobType(t)
		}
	}
	hasOptTS := containsAny(rt, RunTypeOptTS)
	hasOpt := containsAny(rt, RunTypeOpt, RunTypeCOpt)
	hasFreq := containsAny(rt, RunTypeFreq, RunTypeNumFreq, RunTypeAnFreq)
	switch {
	case hasOptTS && hasFreq:
		return JobTypeOptTSFreq
	case hasOptTS:
		return JobTypeOptTS
	case hasOpt && hasFreq:
		return JobTypeOptFreq
	case hasOpt:
		return JobTypeOpt
	case hasFreq:
		return JobTypeFreq
	default:
		return JobType(rt[0])
	}
}

func normalizeRunType(up string) (RunType, bool) {
	if runTypeSet[up] {
		return RunType(up), true
	}
	if alias, ok := runTypeAliases[up]; ok {
		return alias, true
	}
	if strings.HasPrefix(up, "GOAT") {
		return RunTypeGoat, true
	}
	return "", false
}

// hasGeometryDriver reports whether RunTypes already contains a run type
// that drives its own geometry loop, so an opt-tier keyword (TightOpt …)
// merely tunes its convergence criteria instead of requesting a new OPT.
func hasGeometryDriver(rt []RunType) bool {
	for _, t := range rt {
		if t.DrivesGeometry() {
			return true
		}
	}
	return false
}

func containsAny(xs []RunType, needles ...RunType) bool {
	for _, x := range xs {
		for _, n := range needles {
			if x == n {
				return true
			}
		}
	}
	return false
}

// collectBangTokens returns every whitespace-separated token found on
// any `!` line, preserving the input casing.
func collectBangTokens(text string) []string {
	var out []string
	for _, line := range strings.Split(text, "\n") {
		t := strings.TrimSpace(line)
		// Drop trailing comments (`#`).
		if i := strings.Index(t, "#"); i >= 0 {
			t = t[:i]
		}
		if !strings.HasPrefix(t, "!") {
			continue
		}
		body := strings.TrimSpace(t[1:])
		for _, tok := range strings.Fields(body) {
			out = append(out, tok)
		}
	}
	return out
}

// extractFromBlock pulls a number from inside a `%name … end` block.
func extractFromBlock(text, name string, valRe *regexp.Regexp) int {
	re := regexp.MustCompile(`(?is)%\s*` + name + `\b(.*?)\bend\b`)
	m := re.FindStringSubmatch(text)
	if m == nil {
		return 0
	}
	v := valRe.FindStringSubmatch(m[1])
	if v == nil {
		return 0
	}
	return atoi(v[1])
}

var (
	reSolventCall  = regexp.MustCompile(`(?i)^(CPCM|SMD|ALPB|C-PCM)\(([^)]+)\)$`)
	rePalShort     = regexp.MustCompile(`^PAL(\d+)$`)
	reBlockNProcs  = regexp.MustCompile(`(?i)\bnprocs\s*=?\s*(\d+)`)
	reInlineNProcs = regexp.MustCompile(`(?is)%\s*pal\b.*?nprocs\s*=?\s*(\d+).*?\bend\b`)
	reMaxcore      = regexp.MustCompile(`(?i)%\s*maxcore\s+(\d+)`)

	// `*xyz CHARGE MULT`, `*xyzfile CHARGE MULT file`, `*gzmt CHARGE MULT`,
	// `*int CHARGE MULT`. Whitespace between `*` and the keyword is allowed.
	reStarCoords = regexp.MustCompile(`(?im)^\s*\*\s*(xyz|xyzfile|gzmt|int)\s+(-?\d+)\s+(\d+)\b`)

	// `%coords ... charge N ... mult N ... end`
	reBlockCharge = regexp.MustCompile(`(?is)%\s*coords\b[^%]*?\bcharge\s+(-?\d+)`)
	reBlockMult   = regexp.MustCompile(`(?is)%\s*coords\b[^%]*?\bmult\s+(\d+)`)
)

// Known sets. ORCA keyword space is huge; we cover the common ones the
// way researchers actually write them. Unknown tokens still land in
// Keywords for display.

var runTypeSet = stringSet(
	"SP", "ENERGY", "ENGRAD", "OPT", "OPTTS", "COPT", "GOAT", "MECP",
	"FREQ", "NUMFREQ", "ANFREQ",
	"NEB", "NEB-CI", "NEB-TS", "ZOOM-NEB", "ZOOM-NEB-CI", "ZOOM-NEB-TS", "NEB-IDPP",
	"IRC", "SCAN", "SCANTS", "MD", "PROPERTIES", "PROP",
	"TDDFT", "TDA", "CIS", "ESD",
	"NMR", "EPRNMR",
)

// runTypeAliases maps spelled-out convergence-preset variants onto their
// base run type: they differ only in thresholds, and downstream logic
// (tabs, verdicts, restart) must treat them identically. The raw token
// stays visible in Keywords.
var runTypeAliases = map[string]RunType{
	"FAST-NEB-TS":  RunTypeNEBTS,
	"LOOSE-NEB-TS": RunTypeNEBTS,
	"TIGHT-NEB-TS": RunTypeNEBTS,
}

var scfTierSet = stringSet(
	"TIGHTSCF", "VERYTIGHTSCF", "STRONGSCF",
	"NORMALSCF", "LOOSESCF", "SLOPPYSCF", "EXTREMESCF",
)

var correctionSet = stringSet(
	"D2", "D3", "D3ZERO", "D3BJ", "D4",
	"GCP", "NOGCP", "NL", "VV10",
	"RIJCOSX", "RIJK", "NORI", "RI",
)

var optTierSet = stringSet(
	"TIGHTOPT", "VERYTIGHTOPT", "LOOSEOPT", "NORMALOPT",
)

var gridSet = stringSet(
	"DEFGRID1", "DEFGRID2", "DEFGRID3", "DEFGRID4",
)

var spinTagSet = stringSet("UKS", "RKS", "ROKS", "UHF", "RHF", "ROHF")

var wfMethodSet = stringSet(
	"HF", "MP2", "RI-MP2", "SCS-MP2", "DLPNO-MP2",
	"CCSD", "CCSD(T)", "DLPNO-CCSD", "DLPNO-CCSD(T)",
	"CASSCF", "NEVPT2", "CASPT2",
)

// tightBindingSet — semi-empirical / tight-binding methods. These bring
// their own integrated basis so they should not fall through to the
// "default to HF" branch in Parse() when written as the only method
// keyword (e.g. `! XTB Opt`).
var tightBindingSet = stringSet(
	"XTB", "XTB1", "XTB2",
	"GFN-XTB", "GFN1-XTB", "GFN2-XTB", "GFN-FF", "GFNFF",
	"PM3", "AM1", "MNDO", "PM6", "PM7",
)

// reBasisFamilies — patterns that strongly indicate a basis set.
var basisREs = []*regexp.Regexp{
	regexp.MustCompile(`^(?:MA-)?DEF2-(?:M?SVP|SV\(P\)|TZVP|TZVPP|TZVPD|QZVP|QZVPP|QZVPPD|SVPD|TZVPPD)(?:-(?:F12|J|JK))?$`),
	regexp.MustCompile(`^CC-PV[DTQ56]Z(?:-(?:F12|RI|PP|JK))?$`),
	regexp.MustCompile(`^(?:AUG-)?CC-PV[DTQ56]Z(?:-PP)?$`),
	regexp.MustCompile(`^(?:JUN|JUL|MAY|APR)-CC-PV[DTQ]Z$`),
	// Pople split-valence sets: 3-21G / 4-31G / 6-21G / 6-31G / 6-311G with
	// optional diffuse (+ or ++) and polarization functions written either
	// as stars (*, **) or in parentheses ((d), (d,p), (2df,2pd)). Covers
	// e.g. 6-31G*, 6-31+G(d), 6-311+G**, 6-311++G(2df,2pd).
	regexp.MustCompile(`^(?:3-21|4-31|6-21|6-31|6-311)(?:\+{1,2})?G(?:\*{1,2}|\([^)]*\))?$`),
	regexp.MustCompile(`^(?:LANL2|SDD|STO-3G|3-21G|MIDIX|MINIX)$`),
	regexp.MustCompile(`^(?:SARC-)?ZORA-(?:DEF2-)?(?:SVP|TZVP|TZVPP|QZVPP)$`),
	regexp.MustCompile(`^X2C-(?:SVP|TZVP|QZVP)ALL(?:S)?$`),
	regexp.MustCompile(`^AUTO-AUX$`),
}

func isBasis(up string) bool {
	for _, re := range basisREs {
		if re.MatchString(up) {
			return true
		}
	}
	return false
}

// isComposite matches ORCA's "3c" composite methods (and the older 2c
// variants) regardless of capitalization.
var reComposite = regexp.MustCompile(`^(?:R2SCAN-3C|B97-3C|PBEH-3C|HF-3C|HF-3C/MINIX|R2SCAN-3C\(P\)|R2SCAN-3CRPA)$`)

func isComposite(up string) bool {
	return reComposite.MatchString(up)
}

// looksLikeFunctional is a heuristic for known DFT functional names
// (including range-separated and double-hybrids). It deliberately
// over-matches so user-named hybrids still light up; the user can rely
// on the raw Keywords list for ground truth.
var functionalSubstrings = []string{
	"BLYP", "BP86", "PBE0", "PBE", "B3LYP", "B3PW91", "BHANDHLYP",
	"M06", "M06L", "M06-2X", "M062X", "M11", "MN15", "MN12",
	"WB97", "WB97X", "WB97M", "WB97X-V", "WB97X-D3",
	"CAM-B3LYP", "RSXLYP", "CAM-QTP", "LRC-WPBE",
	"R2SCAN", "SCAN", "TPSS", "TPSSH", "TPSS0",
	"REVDSD", "B2PLYP", "DSD-PBEP86", "PWPB95",
	"OPBE", "OLYP", "OPB95", "REVPBE", "RPBE",
	"BHANDH", "X3LYP", "HSE06",
	"B97-D", "B97M-V", "B97M-D3", "B97",
}

func looksLikeFunctional(up string) bool {
	// Quick reject for things obviously not a functional.
	if isBasis(up) || runTypeSet[up] || scfTierSet[up] || correctionSet[up] {
		return false
	}
	for _, s := range functionalSubstrings {
		if strings.Contains(up, s) {
			return true
		}
	}
	return false
}

// lintMiscSet — valid ORCA '!' keywords the classifier has no category
// for (SCF convergers, print levels, population analyses, restarts,
// relativity, units, bare solvation models, …). Only consulted by
// IsRecognizedToken so the linter doesn't cry wolf on them; the
// classifier itself still ignores these.
var lintMiscSet = stringSet(
	// SCF convergence aids
	"SLOWCONV", "VERYSLOWCONV", "EASYCONV", "SOSCF", "NOSOSCF",
	"DIIS", "NODIIS", "KDIIS", "TRAH", "NOTRAH", "AHSCF", "DAMP", "NODAMP",
	"SCFCONV6", "SCFCONV7", "SCFCONV8", "SCFCONV9", "SCFCONV10",
	// Restarts / guesses
	"MOREAD", "AUTOSTART", "NOAUTOSTART", "PATOM", "PMODEL", "HUECKEL", "HCORE", "UNO", "UCO",
	// Integral handling / RI variants not in correctionSet
	"RI-JK", "SPLIT-RI-J", "NOSPLIT-RI-J", "NOCOSX", "CONV", "DIRECT", "SEMIDIRECT",
	"KEEPINTS", "NOKEEPINTS", "KEEPDENS", "NOKEEPDENS", "AUTOAUX",
	// Frozen core
	"FROZENCORE", "NOFROZENCORE", "NOITER",
	// Print levels
	"MINIPRINT", "SMALLPRINT", "NORMALPRINT", "LARGEPRINT",
	"PRINTBASIS", "PRINTMOS", "NOPRINTMOS", "PRINTGAP",
	// Population analyses
	"MULLIKEN", "NOMULLIKEN", "LOEWDIN", "NOLOEWDIN", "MAYER", "NOMAYER",
	"NPA", "NBO", "CHELPG", "HIRSHFELD", "ALLPOP", "NOPOP", "REDUCEDPOP",
	// Symmetry / units / masses
	"USESYM", "NOUSESYM", "ANGS", "BOHRS", "MASS2016",
	// Bare solvation models (solvent defaults to water)
	"CPCM", "SMD", "COSMO", "ALPB", "DDCOSMO",
	// Relativity
	"ZORA", "X2C", "DKH", "DKH2", "IORA", "NESC",
	// Dispersion extras
	"ABC", "SCNL", "NOSCNL", "NONL",
	// Numerics
	"FLOAT", "DOUBLE", "UCFLOAT", "CFLOAT", "USE-SHARK", "NOUSE-SHARK",
)

// reAuxBasis — auxiliary basis tokens like DEF2/J, DEF2/JK, SARC/J,
// DEF2-TZVPP/C, CC-PVTZ/C, W06/J.
var reAuxBasis = regexp.MustCompile(`^[A-Z0-9+()*-]+/(?:J|JK|C|K)$`)

// IsRecognizedToken reports whether a raw '!' token matches any category
// the classifier knows (run type, tier, grid, correction, spin tag,
// method, basis, functional heuristic, solvent call, PALn) or the
// lintMiscSet of valid-but-uncategorized keywords. Used by the input
// linter; mirrors classifyKeyword's chain — keep the two in sync.
func IsRecognizedToken(tok string) bool {
	up := strings.ToUpper(tok)
	if reSolventCall.MatchString(tok) || rePalShort.MatchString(up) {
		return true
	}
	if _, ok := normalizeRunType(up); ok {
		return true
	}
	return scfTierSet[up] || optTierSet[up] || gridSet[up] || correctionSet[up] ||
		spinTagSet[up] || isComposite(up) || wfMethodSet[up] || tightBindingSet[up] ||
		isBasis(up) || looksLikeFunctional(up) || lintMiscSet[up] || reAuxBasis.MatchString(up)
}

// KnownTokenVocabulary returns the upper-cased keywords the linter can
// suggest as "did you mean" targets: every set member plus common
// composites, functionals and def2 bases spelled out.
func KnownTokenVocabulary() []string {
	var out []string
	for _, set := range []map[string]bool{
		runTypeSet, scfTierSet, optTierSet, gridSet, correctionSet,
		spinTagSet, wfMethodSet, tightBindingSet, lintMiscSet,
	} {
		for k := range set {
			out = append(out, k)
		}
	}
	for k := range runTypeAliases {
		out = append(out, k)
	}
	out = append(out,
		"R2SCAN-3C", "B97-3C", "PBEH-3C", "HF-3C",
		"B3LYP", "PBE0", "PBE", "TPSS", "TPSSH", "M06-2X", "WB97X-V", "WB97X-D3", "CAM-B3LYP", "B2PLYP",
		"DEF2-SVP", "DEF2-SV(P)", "DEF2-TZVP", "DEF2-TZVPP", "DEF2-TZVPD", "DEF2-QZVP", "DEF2-QZVPP",
		"DEF2/J", "DEF2/JK",
	)
	return out
}

func stringSet(xs ...string) map[string]bool {
	m := make(map[string]bool, len(xs))
	for _, x := range xs {
		m[x] = true
	}
	return m
}

func atoi(s string) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			break
		}
		d := int(c - '0')
		// Guard the accumulation: an absurdly long digit run (e.g. a malformed
		// %maxcore) would otherwise overflow int and wrap to a garbage/negative
		// value silently. Saturate at MaxInt instead.
		if n > (math.MaxInt-d)/10 {
			return math.MaxInt
		}
		n = n*10 + d
	}
	return n
}
