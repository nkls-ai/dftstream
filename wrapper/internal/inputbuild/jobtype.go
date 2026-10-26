package inputbuild

import (
	"strings"

	"github.com/nkls-ai/dftstream/internal/inputparse"
)

// JobType is what the user wants computed. It owns the '!' run keywords
// that request it, so no call site spells "OptTS Freq" by hand.
//
// It is deliberately narrower than inputparse.RunType (which classifies
// anything ORCA can be asked to do): these are the jobs the builder and
// the follow-up generators can construct from scratch.
type JobType string

const (
	// JobSP is a single point. ORCA's own default when no run keyword is
	// present, so it contributes none.
	JobSP JobType = "sp"
	// JobOpt is a geometry optimization to a minimum.
	JobOpt JobType = "opt"
	// JobOptFreq optimizes and then verifies with frequencies — the
	// combination that makes a thermochemistry-grade minimum.
	JobOptFreq JobType = "opt-freq"
	// JobFreq is frequencies at a fixed geometry.
	JobFreq JobType = "freq"
	// JobOptTS is a saddle-point search.
	JobOptTS JobType = "opt-ts"
	// JobOptTSFreq searches a saddle point and verifies the single
	// imaginary mode.
	JobOptTSFreq JobType = "opt-ts-freq"
	// JobNEBTS runs a nudged-elastic-band TS search (needs an NEBBlock).
	JobNEBTS JobType = "neb-ts"
	// JobNEBTSFreq runs NEB-TS and verifies the saddle.
	JobNEBTSFreq JobType = "neb-ts-freq"
	// JobIRC follows the intrinsic reaction coordinate from a TS.
	JobIRC JobType = "irc"
	// JobGoat is a global conformer/ensemble search.
	JobGoat JobType = "goat"
	// JobGoatEntropy is GOAT with the conformational entropy protocol.
	JobGoatEntropy JobType = "goat-entropy"
	// JobScan is a relaxed surface scan: an optimization at each point of
	// a driven internal coordinate. The scan itself lives in the %geom
	// Scan block (see GeomBlock.Scans); the run keyword is a plain Opt.
	JobScan JobType = "scan"
	// JobTDDFT is a TD-DFT absorption calculation at a fixed geometry.
	// ORCA requests it through the %tddft block (see TDDFTBlock), not a
	// run keyword, so the job contributes none — like a single point.
	JobTDDFT JobType = "tddft"
	// JobNMR computes GIAO NMR shieldings at a fixed geometry.
	JobNMR JobType = "nmr"
	// JobMECP searches the minimum-energy crossing point between two spin
	// surfaces; the second state's multiplicity lives in the %mecp block
	// (see MECPBlock).
	JobMECP JobType = "mecp"
)

// jobKeywordTable is the single mapping from job type to '!' tokens.
var jobKeywordTable = map[JobType][]string{
	JobSP:          nil,
	JobOpt:         {"Opt"},
	JobOptFreq:     {"Opt", "Freq"},
	JobFreq:        {"Freq"},
	JobOptTS:       {"OptTS"},
	JobOptTSFreq:   {"OptTS", "Freq"},
	JobNEBTS:       {"NEB-TS"},
	JobNEBTSFreq:   {"NEB-TS", "Freq"},
	JobIRC:         {"IRC"},
	JobGoat:        {"GOAT"},
	JobGoatEntropy: {"GOAT-Entropy"},
	JobScan:        {"Opt"},
	JobTDDFT:       nil,
	JobNMR:         {"NMR"},
	JobMECP:        {"MECP"},
}

// Keywords returns the '!' run keywords for the job, in the order ORCA
// users write them. Unknown job types yield none.
func (j JobType) Keywords() []string {
	kws := jobKeywordTable[j]
	return append([]string(nil), kws...)
}

// Valid reports whether the job type is one this package knows.
func (j JobType) Valid() bool {
	_, ok := jobKeywordTable[j]
	return ok
}

// ParseJobType resolves a job-type name (as stored in presets / sent by
// the UI); ok is false for anything unknown, so a typo never silently
// becomes a single point.
func ParseJobType(s string) (JobType, bool) {
	j := JobType(strings.ToLower(strings.TrimSpace(s)))
	return j, j.Valid()
}

// NeedsFrequencies reports whether the job computes a Hessian, i.e.
// whether a .hess for a follow-up IRC will exist afterwards.
func (j JobType) NeedsFrequencies() bool {
	for _, k := range jobKeywordTable[j] {
		if inputparse.IsFreqKeyword(k) {
			return true
		}
	}
	return false
}

// StripRunKeywords removes every keyword that drives a geometry or
// frequency job (Opt/opt tiers, Freq, the NEB drivers, IRC) from a
// parent's '!' tokens, leaving the method/basis/accuracy tokens that a
// follow-up job should inherit.
func StripRunKeywords(orig []string) []string {
	var out []string
	for _, tok := range orig {
		if isRunKeyword(tok) {
			continue
		}
		out = append(out, tok)
	}
	return out
}

func isRunKeyword(tok string) bool {
	return inputparse.IsOptKeyword(tok) || inputparse.IsFreqKeyword(tok) ||
		inputparse.IsNEBKeyword(tok) ||
		strings.EqualFold(tok, string(inputparse.RunTypeIRC)) ||
		strings.EqualFold(tok, string(inputparse.RunTypeMECP)) ||
		strings.EqualFold(tok, string(inputparse.RunTypeNMR))
}

// KeywordsFor rewrites a parent's '!' tokens for a new job: the parent's
// run keywords are dropped and the job's own appended, so the method,
// basis and accuracy settings carry over unchanged.
func KeywordsFor(orig []string, job JobType) []string {
	return append(StripRunKeywords(orig), job.Keywords()...)
}

// MergeKeyword appends tok unless an equal-folding token is already
// present, keeping a keyword line free of duplicates ORCA would reject.
func MergeKeyword(keywords []string, tok string) []string {
	if tok == "" {
		return keywords
	}
	for _, k := range keywords {
		if strings.EqualFold(k, tok) {
			return keywords
		}
	}
	return append(keywords, tok)
}
