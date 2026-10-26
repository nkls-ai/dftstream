// Package inputlint pre-flight-checks an ORCA input file for the
// mistakes that waste queue time: a charge/multiplicity pair that cannot
// match the electron count (ORCA aborts immediately — often hours after
// the job left the queue), memory requests past the machine's RAM, a
// missing coordinates file, and likely keyword typos.
package inputlint

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/nkls-ai/dftstream/internal/inputparse"
)

type Severity string

const (
	SeverityError Severity = "error"
	SeverityWarn  Severity = "warn"
	SeverityInfo  Severity = "info"
)

type Finding struct {
	Severity Severity
	// Stable machine-readable code, e.g. "charge-mult-parity".
	Code    string
	Message string
}

// Options carries the environment the checks need. Zero values disable
// the corresponding check.
type Options struct {
	// Dir resolves relative xyzfile references (usually the input's dir).
	Dir string
	// TotalRAMMB enables the %maxcore × nprocs memory check.
	TotalRAMMB int
}

// Lint runs every check against the input text and returns the findings,
// errors first.
func Lint(text string, opts Options) []Finding {
	summary := inputparse.Parse(text)
	var errs, warns, infos []Finding
	add := func(f Finding) {
		switch f.Severity {
		case SeverityError:
			errs = append(errs, f)
		case SeverityWarn:
			warns = append(warns, f)
		default:
			infos = append(infos, f)
		}
	}

	for _, f := range checkChargeMult(text, summary, opts) {
		add(f)
	}
	for _, f := range checkResources(summary, opts) {
		add(f)
	}
	for _, f := range checkKeywords(summary) {
		add(f)
	}
	for _, f := range checkStrayLines(text) {
		add(f)
	}
	for _, f := range checkNonASCII(text) {
		add(f)
	}
	return append(append(errs, warns...), infos...)
}

// HasErrors reports whether any finding is error severity.
func HasErrors(findings []Finding) bool {
	for _, f := range findings {
		if f.Severity == SeverityError {
			return true
		}
	}
	return false
}

// reCoordHeader matches the coordinate-spec line, capturing kind, charge,
// mult and (for xyzfile) the trailing filename.
var reCoordHeader = regexp.MustCompile(`(?im)^\s*\*\s*(xyz|xyzfile|gzmt|int)\s+(-?\d+)\s+(\d+)\s*(\S*)`)

// reCoordAtom matches an element symbol leading a coordinate row.
var reCoordAtom = regexp.MustCompile(`^\s*([A-Za-z]{1,2})(?:\s|\()`)

func checkChargeMult(text string, summary inputparse.Summary, opts Options) []Finding {
	m := reCoordHeader.FindStringSubmatch(text)
	if m == nil {
		if summary.Charge == nil {
			return []Finding{{
				Severity: SeverityWarn,
				Code:     "no-coords",
				Message:  "no coordinate block found (* xyz CHARGE MULT … or * xyzfile CHARGE MULT file)",
			}}
		}
		return nil
	}
	kind := strings.ToLower(m[1])
	charge, mult := summary.Charge, summary.Mult
	if charge == nil || mult == nil {
		return nil
	}
	if *mult < 1 {
		return []Finding{{
			Severity: SeverityError,
			Code:     "mult-invalid",
			Message:  fmt.Sprintf("multiplicity %d is invalid — must be ≥ 1 (2S+1)", *mult),
		}}
	}

	var findings []Finding
	elements, ok := coordElements(text, kind, m[4], opts)
	if kind == "xyzfile" && m[4] != "" && opts.Dir != "" {
		path := m[4]
		if !filepath.IsAbs(path) {
			path = filepath.Join(opts.Dir, path)
		}
		if _, err := os.Stat(path); err != nil {
			findings = append(findings, Finding{
				Severity: SeverityError,
				Code:     "xyzfile-missing",
				Message:  fmt.Sprintf("coordinates file %q not found", m[4]),
			})
		}
	}
	if !ok || len(elements) == 0 {
		return findings
	}

	electrons := 0
	for _, el := range elements {
		z, known := atomicNumbers[normalizeElement(el)]
		if !known {
			findings = append(findings, Finding{
				Severity: SeverityWarn,
				Code:     "unknown-element",
				Message:  fmt.Sprintf("unknown element symbol %q in coordinates — electron-parity check skipped", el),
			})
			return findings
		}
		electrons += z
	}
	electrons -= *charge

	// n_unpaired = mult − 1 must have the same parity as the electron
	// count: an odd number of electrons cannot form a singlet (mult 1),
	// an even number cannot form a doublet (mult 2), etc.
	if (electrons-(*mult-1))%2 != 0 {
		findings = append(findings, Finding{
			Severity: SeverityError,
			Code:     "charge-mult-parity",
			Message: fmt.Sprintf(
				"charge %d / multiplicity %d is impossible: %d electrons (%s) — an %s electron count needs an %s multiplicity. ORCA will abort immediately.",
				*charge, *mult, electrons,
				fmt.Sprintf("Σ Z − charge, %d atoms", len(elements)),
				parityWord(electrons), parityWord(electrons+1),
			),
		})
	}
	return findings
}

func parityWord(n int) string {
	if n%2 == 0 {
		return "even"
	}
	return "odd"
}

// coordElements returns the element symbols of the molecule. For inline
// blocks it scans the lines after the header until the closing '*'; for
// xyzfile it reads the referenced file (standard xyz layout) when Dir is
// known. ok=false means the geometry could not be determined.
func coordElements(text, kind, fileRef string, opts Options) ([]string, bool) {
	switch kind {
	case "xyz", "gzmt", "int":
		lines := strings.Split(text, "\n")
		start := -1
		for i, line := range lines {
			if reCoordHeader.MatchString(line) {
				start = i + 1
				break
			}
		}
		if start < 0 {
			return nil, false
		}
		var out []string
		for _, line := range lines[start:] {
			t := strings.TrimSpace(line)
			if t == "*" || strings.HasPrefix(t, "*") {
				break
			}
			if t == "" {
				continue
			}
			m := reCoordAtom.FindStringSubmatch(line)
			if m == nil {
				// gzmt/int blocks carry non-atom continuation rows; an
				// unparseable row in an xyz block ends the element scan.
				if kind == "xyz" {
					break
				}
				continue
			}
			out = append(out, m[1])
		}
		return out, true
	case "xyzfile":
		if fileRef == "" || opts.Dir == "" {
			return nil, false
		}
		path := fileRef
		if !filepath.IsAbs(path) {
			path = filepath.Join(opts.Dir, path)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, false
		}
		lines := strings.Split(string(data), "\n")
		if len(lines) < 3 {
			return nil, false
		}
		var out []string
		// Standard xyz: line 0 atom count, line 1 comment, then atoms.
		for _, line := range lines[2:] {
			if strings.TrimSpace(line) == "" {
				continue
			}
			m := reCoordAtom.FindStringSubmatch(line)
			if m == nil {
				break
			}
			out = append(out, m[1])
		}
		return out, true
	}
	return nil, false
}

func normalizeElement(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + strings.ToLower(s[1:])
}

func checkResources(summary inputparse.Summary, opts Options) []Finding {
	var out []Finding
	if summary.NProcs == 0 {
		out = append(out, Finding{
			Severity: SeverityInfo,
			Code:     "no-pal",
			Message:  "no %pal / PALn — ORCA will run on a single core",
		})
	}
	if summary.MaxCoreMB == 0 {
		out = append(out, Finding{
			Severity: SeverityInfo,
			Code:     "no-maxcore",
			Message:  "no %maxcore — ORCA's per-core default is conservative; large jobs may swap to disk integrals",
		})
	}
	if opts.TotalRAMMB > 0 && summary.MaxCoreMB > 0 {
		procs := summary.NProcs
		if procs == 0 {
			procs = 1
		}
		total := summary.MaxCoreMB * procs
		// ORCA treats %maxcore as a soft target and overshoots; past
		// ~75% of physical RAM the OOM killer becomes a real risk.
		if total > opts.TotalRAMMB*3/4 {
			out = append(out, Finding{
				Severity: SeverityWarn,
				Code:     "maxcore-exceeds-ram",
				Message: fmt.Sprintf(
					"%%maxcore %d MB × %d procs = %.1f GB requested, machine has %.1f GB — ORCA overshoots %%maxcore, risk of OOM kill",
					summary.MaxCoreMB, procs,
					float64(total)/1024, float64(opts.TotalRAMMB)/1024,
				),
			})
		}
	}
	return out
}

// checkKeywords is a typo detector, not a validator: ORCA's keyword
// space is huge and version-dependent, so an unrecognized token alone is
// NOT worth a warning (that would cry wolf on every niche keyword).
// A finding fires only when the token sits within a small edit distance
// of a keyword we know — the "Otp" → "OPT" class of mistake.
func checkKeywords(summary inputparse.Summary) []Finding {
	var out []Finding
	var vocab []string // built lazily — most inputs have no typos
	for _, tok := range summary.Keywords {
		if inputparse.IsRecognizedToken(tok) {
			continue
		}
		if vocab == nil {
			vocab = inputparse.KnownTokenVocabulary()
		}
		if suggestion, ok := nearestKeyword(strings.ToUpper(tok), vocab); ok {
			out = append(out, Finding{
				Severity: SeverityWarn,
				Code:     "keyword-typo",
				Message:  fmt.Sprintf("keyword %q looks like a typo — did you mean %q? (ORCA aborts on unknown keywords)", tok, suggestion),
			})
		}
	}
	return out
}

// singleLineDirectives — % directives that take their value on the same
// line with no closing "end".
var singleLineDirectives = map[string]bool{
	"%maxcore": true, "%base": true, "%moinp": true, "%pointcharges": true,
}

// checkStrayLines flags lone short alphabetic tokens sitting outside any
// block — the stray-editor-keystroke class (an "s" from a slipped vim
// command lands exactly like this). Deliberately very conservative to
// avoid false positives from ORCA's many block layouts: only a single
// all-letter token of ≤ 3 characters, outside coordinate blocks, not
// "end", is flagged. Longer junk is left to ORCA itself.
func checkStrayLines(text string) []Finding {
	var out []Finding
	inBlock := 0 // %-block nesting depth (greedy — see below)
	inCoords := false
	for i, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "$") {
			continue
		}
		lower := strings.ToLower(line)
		if inCoords {
			if strings.HasPrefix(line, "*") {
				inCoords = false
			}
			continue
		}
		if strings.HasPrefix(line, "*") {
			// `* xyz|gzmt|int …` opens an inline coordinate block closed
			// by a lone "*"; `* xyzfile …` is single-line.
			if m := reCoordHeader.FindStringSubmatch(raw); m != nil && strings.ToLower(m[1]) != "xyzfile" {
				inCoords = true
			}
			continue
		}
		if strings.HasPrefix(line, "!") {
			continue
		}
		if strings.HasPrefix(line, "%") {
			directive := strings.Fields(lower)[0]
			if !singleLineDirectives[directive] && !strings.HasSuffix(lower, " end") {
				inBlock++
			}
			continue
		}
		if lower == "end" {
			if inBlock > 0 {
				inBlock--
			}
			continue
		}
		if inBlock > 0 {
			// Sub-block openers inside % blocks (Scan, Constraints, …)
			// make exact depth tracking impossible without a full ORCA
			// grammar; the greedy depth plus the strict token filter
			// below keeps this check safe anyway.
			continue
		}
		fields := strings.Fields(line)
		if len(fields) == 1 && len(fields[0]) <= 3 && isAllLetters(fields[0]) {
			out = append(out, Finding{
				Severity: SeverityWarn,
				Code:     "stray-line",
				Message:  fmt.Sprintf("line %d is a stray token %q outside any block — looks like an accidental keystroke; ORCA will likely reject the input", i+1, fields[0]),
			})
		}
	}
	return out
}

// nonASCIINames labels the characters that commonly sneak into inputs via
// copy-paste from web pages, chats, or word processors; anything else is
// reported by its U+XXXX code point alone.
var nonASCIINames = map[rune]string{
	'\u00a0': "no-break space (invisible)",
	'\u200b': "zero-width space (invisible)",
	'\u200c': "zero-width non-joiner (invisible)",
	'\u200d': "zero-width joiner (invisible)",
	'\ufeff': "byte-order mark (invisible)",
	'\u2018': "curly quote",
	'\u2019': "curly quote",
	'\u201c': "curly double quote",
	'\u201d': "curly double quote",
	'\u2013': "en dash",
	'\u2014': "em dash",
	'\u2212': "unicode minus sign",
}

// maxNonASCIILines bounds the per-line findings so a pasted unicode-heavy
// file doesn't drown the report; the remainder is summarized in one line.
const maxNonASCIILines = 5

// checkNonASCII flags any non-ASCII character anywhere in the file. ORCA's
// scanner aborts on them (exit 50: "Please remove all non-ASCII characters
// from your input file"), and the usual culprits — zero-width spaces, curly
// quotes, unicode dashes — are invisible or near-invisible in an editor.
func checkNonASCII(text string) []Finding {
	var out []Finding
	extra := 0
	for i, line := range strings.Split(text, "\n") {
		var first rune = -1
		count := 0
		for _, r := range line {
			// Invalid UTF-8 bytes decode to U+FFFD, which lands here too.
			if r > 0x7f {
				if first < 0 {
					first = r
				}
				count++
			}
		}
		if first < 0 {
			continue
		}
		if len(out) >= maxNonASCIILines {
			extra++
			continue
		}
		name := nonASCIINames[first]
		if name == "" {
			name = "non-ASCII"
		}
		times := ""
		if count > 1 {
			times = fmt.Sprintf(", %d occurrences", count)
		}
		out = append(out, Finding{
			Severity: SeverityError,
			Code:     "non-ascii",
			Message: fmt.Sprintf(
				"line %d contains a %s character U+%04X%s — ORCA aborts on non-ASCII input; delete and retype the line",
				i+1, name, first, times),
		})
	}
	if extra > 0 {
		out = append(out, Finding{
			Severity: SeverityError,
			Code:     "non-ascii",
			Message:  fmt.Sprintf("…and %d more lines with non-ASCII characters", extra),
		})
	}
	return out
}

func isAllLetters(s string) bool {
	for _, r := range s {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') {
			return false
		}
	}
	return len(s) > 0
}

// nearestKeyword returns the closest vocabulary word when it is close
// enough to be a plausible typo: distance 1 always, distance 2 only for
// tokens of length ≥ 6 (short keywords at distance 2 are usually just
// different keywords).
func nearestKeyword(up string, vocab []string) (string, bool) {
	best, bestDist := "", 3
	for _, w := range vocab {
		if w == up {
			continue
		}
		// Cheap length filter before the O(n·m) distance.
		if abs(len(w)-len(up)) >= bestDist {
			continue
		}
		if d := osaDistance(up, w); d < bestDist {
			best, bestDist = w, d
		}
	}
	limit := 1
	if len(up) >= 6 {
		limit = 2
	}
	return best, best != "" && bestDist <= limit
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// osaDistance is the optimal-string-alignment variant of Levenshtein:
// insert / delete / substitute plus adjacent transposition, so the
// classic swapped-letters typo ("Otp") counts as one edit.
func osaDistance(a, b string) int {
	la, lb := len(a), len(b)
	prev2 := make([]int, lb+1)
	prev := make([]int, lb+1)
	cur := make([]int, lb+1)
	for j := 0; j <= lb; j++ {
		prev[j] = j
	}
	for i := 1; i <= la; i++ {
		cur[0] = i
		for j := 1; j <= lb; j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			m := min3(cur[j-1]+1, prev[j]+1, prev[j-1]+cost)
			if i > 1 && j > 1 && a[i-1] == b[j-2] && a[i-2] == b[j-1] {
				if t := prev2[j-2] + 1; t < m {
					m = t
				}
			}
			cur[j] = m
		}
		prev2, prev, cur = prev, cur, prev2
	}
	return prev[lb]
}

func min3(a, b, c int) int {
	if b < a {
		a = b
	}
	if c < a {
		a = c
	}
	return a
}
