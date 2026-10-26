package inputlint

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func codes(fs []Finding) []string {
	out := make([]string, len(fs))
	for i, f := range fs {
		out[i] = f.Code
	}
	return out
}

func hasCode(fs []Finding, code string) bool {
	for _, f := range fs {
		if f.Code == code {
			return true
		}
	}
	return false
}

const waterOK = `! r2SCAN-3c Opt
%pal nprocs 4 end
%maxcore 2000
* xyz 0 1
O   0.0 0.0 0.0
H   0.0 0.0 0.96
H   0.93 0.0 -0.24
*
`

func TestCleanInputHasNoErrorsOrWarnings(t *testing.T) {
	fs := Lint(waterOK, Options{TotalRAMMB: 64000})
	for _, f := range fs {
		if f.Severity != SeverityInfo {
			t.Errorf("unexpected %s finding: %s (%s)", f.Severity, f.Code, f.Message)
		}
	}
}

func TestChargeMultParity(t *testing.T) {
	// Water (10 electrons, even) as a doublet is impossible.
	bad := strings.Replace(waterOK, "* xyz 0 1", "* xyz 0 2", 1)
	fs := Lint(bad, Options{})
	if !hasCode(fs, "charge-mult-parity") {
		t.Fatalf("expected charge-mult-parity, got %v", codes(fs))
	}
	if !HasErrors(fs) {
		t.Error("parity finding should be error severity")
	}

	// Water cation (9 electrons, odd) as a doublet is fine…
	cationDoublet := strings.Replace(waterOK, "* xyz 0 1", "* xyz 1 2", 1)
	if fs := Lint(cationDoublet, Options{}); hasCode(fs, "charge-mult-parity") {
		t.Errorf("cation doublet flagged: %v", codes(fs))
	}
	// …but as a singlet is impossible.
	cationSinglet := strings.Replace(waterOK, "* xyz 0 1", "* xyz 1 1", 1)
	if fs := Lint(cationSinglet, Options{}); !hasCode(fs, "charge-mult-parity") {
		t.Errorf("cation singlet not flagged: %v", codes(fs))
	}
}

func TestInvalidMultiplicity(t *testing.T) {
	bad := strings.Replace(waterOK, "* xyz 0 1", "* xyz 0 0", 1)
	if fs := Lint(bad, Options{}); !hasCode(fs, "mult-invalid") {
		t.Errorf("mult 0 not flagged: %v", codes(fs))
	}
}

func TestXyzfileMissingAndParityFromFile(t *testing.T) {
	dir := t.TempDir()
	input := `! BP86 def2-SVP
* xyzfile 0 2 water.xyz
`
	fs := Lint(input, Options{Dir: dir})
	if !hasCode(fs, "xyzfile-missing") {
		t.Fatalf("missing xyzfile not flagged: %v", codes(fs))
	}

	xyz := "3\nwater\nO 0.0 0.0 0.0\nH 0.0 0.0 0.96\nH 0.93 0.0 -0.24\n"
	if err := os.WriteFile(filepath.Join(dir, "water.xyz"), []byte(xyz), 0o644); err != nil {
		t.Fatal(err)
	}
	fs = Lint(input, Options{Dir: dir})
	if hasCode(fs, "xyzfile-missing") {
		t.Errorf("existing xyzfile still flagged: %v", codes(fs))
	}
	// 10 electrons as doublet → parity error, read from the file.
	if !hasCode(fs, "charge-mult-parity") {
		t.Errorf("parity from xyzfile not flagged: %v", codes(fs))
	}
}

func TestMaxcoreVsRAM(t *testing.T) {
	// 8 procs × 6000 MB = 48 GB on a 32 GB machine.
	input := strings.Replace(
		strings.Replace(waterOK, "%maxcore 2000", "%maxcore 6000", 1),
		"nprocs 4", "nprocs 8", 1)
	fs := Lint(input, Options{TotalRAMMB: 32000})
	if !hasCode(fs, "maxcore-exceeds-ram") {
		t.Errorf("oversubscribed maxcore not flagged: %v", codes(fs))
	}
	// Same input on a big machine: fine.
	if fs := Lint(input, Options{TotalRAMMB: 256000}); hasCode(fs, "maxcore-exceeds-ram") {
		t.Errorf("maxcore flagged on large machine: %v", codes(fs))
	}
}

func TestKeywordTypoDetection(t *testing.T) {
	cases := map[string]string{
		"Otp":       "OPT",      // transposition
		"TIGTHSCF":  "TIGHTSCF", // transposition inside
		"TightSFC":  "TIGHTSCF",
		"RIJCOSXX":  "RIJCOSX", // one insertion
		"DEFGRID33": "DEFGRID3",
	}
	for typo, want := range cases {
		input := strings.Replace(waterOK, "! r2SCAN-3c Opt", "! r2SCAN-3c Opt "+typo, 1)
		fs := Lint(input, Options{})
		if !hasCode(fs, "keyword-typo") {
			t.Errorf("typo %q not flagged: %v", typo, codes(fs))
			continue
		}
		found := false
		for _, f := range fs {
			if f.Code == "keyword-typo" && strings.Contains(f.Message, want) {
				found = true
			}
		}
		if !found {
			t.Errorf("typo %q: suggestion %q missing in findings %v", typo, want, fs)
		}
	}
}

// Unknown-but-plausible tokens must stay SILENT: ORCA's keyword space is
// huge, and warning on every keyword DFTStream doesn't know would train
// users to ignore the linter.
func TestUnknownButNotSimilarKeywordsStaySilent(t *testing.T) {
	for _, kw := range []string{"SOMEFUTUREKEYWORD", "QRRHOX99", "MYCUSTOMTHING"} {
		input := strings.Replace(waterOK, "! r2SCAN-3c Opt", "! r2SCAN-3c Opt "+kw, 1)
		if fs := Lint(input, Options{}); hasCode(fs, "keyword-typo") {
			t.Errorf("unrelated keyword %q flagged as typo: %v", kw, fs)
		}
	}
}

// Battery of real-world keywords that must never produce a warning.
func TestCommonKeywordsProduceNoWarnings(t *testing.T) {
	common := []string{
		"RIJCOSX", "NORI", "RI", "RIJK", "RI-JK", "NOCOSX",
		"MOREAD", "AUTOSTART", "NOAUTOSTART", "AUTOAUX",
		"SlowConv", "VerySlowConv", "EasyConv", "SOSCF", "NOSOSCF", "KDIIS", "DIIS", "NODIIS", "TRAH", "NOTRAH",
		"NoFrozenCore", "FrozenCore", "NoIter",
		"LargePrint", "MiniPrint", "NormalPrint", "PrintBasis", "PrintMOs", "PrintGap",
		"NoUseSym", "UseSym", "UNO", "UCO",
		"Angs", "Bohrs", "Mass2016",
		"CPCM", "SMD", "CPCM(Water)", "SMD(Acetonitrile)", "ALPB(THF)",
		"NBO", "CHELPG", "Hirshfeld", "AllPop", "NoPop", "Mayer", "Loewdin", "Mulliken", "ReducedPop",
		"D3", "D3ZERO", "D3BJ", "D4", "ABC", "NL", "SCNL",
		"def2/J", "def2/JK", "def2-TZVPP/C", "cc-pVTZ/C", "SARC/J",
		"ZORA", "X2C", "DKH", "DKH2",
		"UHF", "UKS", "RKS", "RHF", "ROHF", "ROKS",
		"Opt", "Freq", "NumFreq", "TightSCF", "TightOpt", "DEFGRID3",
		"XTB", "GFN2-xTB", "r2SCAN-3c", "B3LYP", "def2-SVP", "wB97X-V",
		"DLPNO-CCSD(T)", "CCSD(T)", "MP2", "RI-MP2", "DLPNO-MP2",
		"PAL8", "SP", "EnGrad", "MiniX",
	}
	for _, kw := range common {
		input := strings.Replace(waterOK, "! r2SCAN-3c Opt", "! r2SCAN-3c Opt "+kw, 1)
		if fs := Lint(input, Options{}); hasCode(fs, "keyword-typo") {
			t.Errorf("legit keyword %q flagged as typo: %v", kw, fs)
		}
	}
}

// The stray-keystroke class: a lone short token outside any block (a
// slipped editor command like "s") — ORCA rejects the input line.
func TestStrayLineDetection(t *testing.T) {
	input := "! r2SCAN-3c TightOpt Freq\n%maxcore 3000\n%pal\n  nprocs 8\nend\ns\n* xyzfile 0 1 min.xyz\n"
	fs := Lint(input, Options{})
	if !hasCode(fs, "stray-line") {
		t.Fatalf("stray 's' not flagged: %v", codes(fs))
	}
	for _, f := range fs {
		if f.Code == "stray-line" && !strings.Contains(f.Message, "line 6") {
			t.Errorf("stray-line message missing line number: %s", f.Message)
		}
	}
}

func TestStrayLineNoFalsePositives(t *testing.T) {
	cases := map[string]string{
		// Bare element symbol is legal as a Z-matrix's first atom.
		"gzmt bare element": "! Opt\n* gzmt 0 1\nO\nH 1 0.96\n*\n",
		// Sub-block "end" must not make later block content look stray.
		"nested geom block": "! Opt\n%geom\n  Constraints\n    { B 0 1 C }\n  end\n  Calc_Hess true\nend\n* xyz 0 1\nO 0 0 0\n*\n",
		// Lone "end" (even unbalanced) is never a stray token.
		"unbalanced end": "! SP\nend\n* xyz 0 1\nO 0 0 0\n*\n",
		// Single-line directives don't open a block that eats the rest.
		"single-line directives": "! SP\n%maxcore 3000\n%base \"job1\"\n* xyz 0 1\nO 0 0 0\n*\n",
		// Comments and $new_job markers pass.
		"comments": "# header comment\n! SP\n$new_job\n* xyz 0 1\nO 0 0 0\n*\n",
	}
	for name, input := range cases {
		if fs := Lint(input, Options{}); hasCode(fs, "stray-line") {
			t.Errorf("%s: false stray-line: %v", name, fs)
		}
	}
}

// The linter must never panic or flag errors on degenerate input — it
// runs in front of every `dftstream run`.
func TestRobustOnDegenerateInput(t *testing.T) {
	cases := []string{
		"",
		"\x00\x01\x02 garbage \xff",
		"! Opt\n* xyz 0 1\n*\n",           // empty coordinate block
		"! Opt\n* xyz 0 1\nZz 0 0 0\n*\n", // unknown element
		"! Opt\r\n* xyz 0 1\r\nO 0 0 0\r\nH 0 0 0.96\r\nh 0.9 0 0\r\n*\r\n", // CRLF + lowercase element
		"* xyz -2 1\nO 0 0 0\n*\n",                     // negative charge, no ! line
		strings.Repeat("! Opt\n", 5000),                // many bang lines
		"! Opt\n%coords\n  charge -1\n  mult 2\nend\n", // %coords block form
	}
	for i, text := range cases {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("case %d panicked: %v", i, r)
				}
			}()
			Lint(text, Options{TotalRAMMB: 1024})
		}()
	}
}

// Lowercase elements normalize; CRLF line endings parse.
func TestParityWithCRLFAndLowercaseElements(t *testing.T) {
	input := "! BP86 def2-SVP\r\n* xyz 0 2\r\nO 0 0 0\r\nh 0 0 0.96\r\nH 0.9 0 0\r\n*\r\n"
	if fs := Lint(input, Options{}); !hasCode(fs, "charge-mult-parity") {
		t.Errorf("CRLF/lowercase parity not flagged: %v", codes(fs))
	}
}

func TestFindingsOrderedErrorsFirst(t *testing.T) {
	bad := strings.Replace(waterOK, "* xyz 0 1", "* xyz 0 2", 1)
	bad = strings.Replace(bad, "%pal nprocs 4 end\n", "", 1)
	fs := Lint(bad, Options{})
	if len(fs) < 2 || fs[0].Severity != SeverityError {
		t.Errorf("errors not first: %v", codes(fs))
	}
}

func TestNonASCIIDetection(t *testing.T) {
	// The real-world case: zero-width spaces pasted invisibly into keyword
	// and coordinate lines (ORCA exit 50).
	input := "! \u200bOptTS Freq\n%pal nprocs 8 end\n* xyz -1 1\nC 0 0 0\u200b\u200b\n*\n"
	fs := Lint(input, Options{})
	if !hasCode(fs, "non-ascii") {
		t.Fatalf("zero-width space not flagged: %v", codes(fs))
	}
	var msgs []string
	for _, f := range fs {
		if f.Code == "non-ascii" {
			if f.Severity != SeverityError {
				t.Errorf("non-ascii severity = %s, want error", f.Severity)
			}
			msgs = append(msgs, f.Message)
		}
	}
	if len(msgs) != 2 {
		t.Fatalf("want 2 non-ascii findings (lines 1 and 4), got %d: %v", len(msgs), msgs)
	}
	if !strings.Contains(msgs[0], "line 1") || !strings.Contains(msgs[0], "zero-width space") || !strings.Contains(msgs[0], "U+200B") {
		t.Errorf("first message lacks line/name/codepoint: %q", msgs[0])
	}
	if !strings.Contains(msgs[1], "line 4") || !strings.Contains(msgs[1], "2 occurrences") {
		t.Errorf("second message lacks line/count: %q", msgs[1])
	}
}

func TestNonASCIINamesCommonCulprits(t *testing.T) {
	cases := map[string]string{
		"! Opt \u00a0\n":  "no-break space",
		"# note \u2019\n": "curly quote",
		"! Opt \u2013\n":  "en dash",
		"! Opt \u2212\n":  "unicode minus",
		"! Opt \u00e9\n":  "U+00E9", // unnamed → code point only
	}
	for input, want := range cases {
		fs := Lint(input, Options{})
		found := false
		for _, f := range fs {
			if f.Code == "non-ascii" && strings.Contains(f.Message, want) {
				found = true
			}
		}
		if !found {
			t.Errorf("input %q: no non-ascii finding mentioning %q: %v", input, want, fs)
		}
	}
}

func TestNonASCIICapsFindings(t *testing.T) {
	input := strings.Repeat("! Opt \u200b\n", 9)
	var got, summaries int
	for _, f := range Lint(input, Options{}) {
		if f.Code != "non-ascii" {
			continue
		}
		if strings.Contains(f.Message, "more lines") {
			summaries++
			if !strings.Contains(f.Message, "4 more lines") {
				t.Errorf("summary should count 4 remaining lines: %q", f.Message)
			}
		} else {
			got++
		}
	}
	if got != 5 || summaries != 1 {
		t.Errorf("want 5 per-line findings + 1 summary, got %d + %d", got, summaries)
	}
}

func TestNonASCIISilentOnCleanInput(t *testing.T) {
	for _, f := range Lint(waterOK, Options{}) {
		if f.Code == "non-ascii" {
			t.Errorf("clean ASCII input flagged: %q", f.Message)
		}
	}
}

// Fuzz target: Lint must never panic, whatever bytes it is fed — it runs
// in front of every `dftstream run`. (`go test -fuzz=FuzzLint` explores;
// plain `go test` replays the seed corpus.)
func FuzzLint(f *testing.F) {
	f.Add(waterOK)
	f.Add("")
	f.Add("! Opt\n* xyzfile 0 1 missing.xyz\n")
	f.Add("* xyz -1 2\nO 0 0 0\n*")
	f.Add("! B3LYP def2-SVP Otp\n%pal nprocs 8 end\n%maxcore 90000\n* xyz 0 1\nFe 0 0 0\n*\n")
	f.Add("%coords\ncharge -1\nmult 2\nend")
	f.Fuzz(func(t *testing.T, text string) {
		Lint(text, Options{Dir: t.TempDir(), TotalRAMMB: 1024})
	})
}
