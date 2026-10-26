package followup

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// Golden tests pin the EXACT bytes of every generated follow-up input.
// These files are submitted to real clusters, so any renderer change
// (e.g. the move onto the typed inputbuild model) must be provably
// byte-identical. Regenerate deliberately with:
//
//	DFTSTREAM_UPDATE_GOLDEN=1 go test ./internal/followup/
//
// and review the diff — a changed golden is a changed cluster job.

// goldenScenario is one generator invocation plus the sibling files it
// needs on disk. Files are materialized under a fixed-name directory so
// the provenance comment (which embeds the parent directory name) is
// reproducible.
type goldenScenario struct {
	name      string
	generator string
	// setup writes the parents into dir and returns the request.
	setup func(t *testing.T, dir string) Request
}

const goldenExpDir = "goldenexp"

func goldenScenarios() []goldenScenario {
	return []goldenScenario{
		{
			name:      "neb-ts",
			generator: "neb-ts",
			setup: func(t *testing.T, dir string) Request {
				reactant := mkSource(t, dir, "hcn", "! XTB Opt Freq TightSCF\n%pal nprocs 4 end\n%maxcore 3000\n* xyz 0 1\nC 0 0 0\nN 0 0 1.16\nH 0 0 -1.07\n*\n", convergedMinOut)
				product := mkSource(t, dir, "hnc", "! XTB Opt Freq TightSCF\n* xyz 0 1\nC 0 0 0\nN 0 0 1.16\nH 0 0 2.16\n*\n", convergedMinOut)
				return Request{Sources: []Source{reactant, product}, NImages: 12}
			},
		},
		{
			name:      "neb-ts-default-images",
			generator: "neb-ts",
			setup: func(t *testing.T, dir string) Request {
				reactant := mkSource(t, dir, "r", "! r2SCAN-3c TightOpt Freq CPCM(water)\n* xyz -1 2\nC 0 0 0\nN 0 0 1.16\nH 0 0 -1.07\n*\n", convergedMinOut)
				product := mkSource(t, dir, "p", "! r2SCAN-3c TightOpt Freq CPCM(water)\n* xyz -1 2\nC 0 0 0\nN 0 0 1.16\nH 0 0 2.16\n*\n", convergedMinOut)
				return Request{Sources: []Source{reactant, product}}
			},
		},
		{
			name:      "irc-with-hess",
			generator: "irc",
			setup: func(t *testing.T, dir string) Request {
				ts := mkSource(t, dir, "ts", "! XTB OptTS Freq\n%pal nprocs 8 end\n* xyz 0 1\nC 0 0 0\nN 0 0 1.16\nH 0 0 -1.07\n*\n", convergedTSOut)
				writeFile(t, ts.Stem+".hess", "$hessian\n")
				return Request{Sources: []Source{ts}}
			},
		},
		{
			name:      "irc-without-hess",
			generator: "irc",
			setup: func(t *testing.T, dir string) Request {
				ts := mkSource(t, dir, "ts_nohess", "! wB97X-D4 def2-TZVP OptTS Freq SMD(Acetonitrile)\n%maxcore 4000\n* xyz 1 1\nC 0 0 0\nN 0 0 1.16\nH 0 0 -1.07\n*\n", convergedTSOut)
				return Request{Sources: []Source{ts}}
			},
		},
		{
			name:      "opt-endpoints-both-directions",
			generator: "opt-endpoints",
			setup: func(t *testing.T, dir string) Request {
				irc := mkSource(t, dir, "irc", "! XTB IRC\n* xyz 0 1\nC 0 0 0\nN 0 0 1.16\nH 0 0 -1.07\n*\n", convergedTSOut)
				trj := "3\nframe 1\nC 0.0 0.0 0.0\nN 0.0 0.0 1.16\nH 0.0 0.0 -1.07\n3\nframe 2\nC 0.0 0.0 0.5\nN 0.0 0.0 1.5\nH 0.0 0.0 -0.5\n"
				writeFile(t, irc.Stem+"_IRC_F_trj.xyz", trj)
				writeFile(t, irc.Stem+"_IRC_B_trj.xyz", trj)
				return Request{Sources: []Source{irc}}
			},
		},
		{
			name:      "opt-endpoints-full-fallback",
			generator: "opt-endpoints",
			setup: func(t *testing.T, dir string) Request {
				irc := mkSource(t, dir, "ircfull", "! r2SCAN-3c IRC\n%pal nprocs 16 end\n%maxcore 2000\n* xyz 0 1\nH 0 0 0\nH 0 0 0.7\n*\n", convergedTSOut)
				full := "2\nendpoint A\nH 0.0 0.0 0.0\nH 0.0 0.0 0.7\n2\nTS-ish middle\nH 0.0 0.0 0.2\nH 0.0 0.0 0.9\n2\nendpoint B\nH 0.0 0.0 0.4\nH 0.0 0.0 1.1\n"
				writeFile(t, irc.Stem+"_IRC_Full_trj.xyz", full)
				return Request{Sources: []Source{irc}}
			},
		},
		{
			name:      "sp-carries-solvent",
			generator: "sp",
			setup: func(t *testing.T, dir string) Request {
				src := mkSource(t, dir, "min", "! r2SCAN-3c Opt Freq CPCM(water)\n%maxcore 4000\n* xyz 0 1\nC 0 0 0\nN 0 0 1.16\nH 0 0 -1.07\n*\n", convergedMinOut)
				return Request{Sources: []Source{src}, Method: "! DLPNO-CCSD(T) cc-pVTZ cc-pVTZ/C TightSCF"}
			},
		},
		{
			name:      "sp-gas-phase",
			generator: "sp",
			setup: func(t *testing.T, dir string) Request {
				src := mkSource(t, dir, "gas", "! B97-3c Opt Freq\n%pal nprocs 2 end\n* xyz 0 3\nC 0 0 0\nN 0 0 1.16\nH 0 0 -1.07\n*\n", convergedMinOut)
				return Request{Sources: []Source{src}, Method: "wB97X-V def2-QZVPP VeryTightSCF DEFGRID3"}
			},
		},
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestGeneratedInputsAreByteIdentical renders every scenario and compares
// the generated .inp bytes against the checked-in goldens.
func TestGeneratedInputsAreByteIdentical(t *testing.T) {
	update := os.Getenv("DFTSTREAM_UPDATE_GOLDEN") != ""
	goldenDir := filepath.Join("testdata", "golden")
	if update {
		if err := os.MkdirAll(goldenDir, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	for _, sc := range goldenScenarios() {
		t.Run(sc.name, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), goldenExpDir)
			if err := os.MkdirAll(dir, 0o755); err != nil {
				t.Fatal(err)
			}
			req := sc.setup(t, dir)
			gen, ok := Registry[sc.generator]
			if !ok {
				t.Fatalf("unknown generator %q", sc.generator)
			}
			res, err := gen.Generate(req)
			if err != nil {
				t.Fatal(err)
			}
			got := renderScenario(res, dir)
			goldenPath := filepath.Join(goldenDir, sc.name+".txt")
			if update {
				writeFile(t, goldenPath, got)
				return
			}
			want, err := os.ReadFile(goldenPath)
			if err != nil {
				t.Fatalf("missing golden (run with DFTSTREAM_UPDATE_GOLDEN=1): %v", err)
			}
			if got != string(want) {
				t.Errorf("generated bytes changed.\n--- want ---\n%s\n--- got ---\n%s", want, got)
			}
		})
	}
}

// renderScenario serializes a Result into one comparable document:
// every file (path relative to dir) with its exact content, plus the
// warnings. Files keep the generator's order; warnings are sorted so the
// document is stable.
func renderScenario(res Result, dir string) string {
	var b strings.Builder
	for _, f := range res.Files {
		rel, err := filepath.Rel(dir, f.Path)
		if err != nil {
			rel = filepath.Base(f.Path)
		}
		b.WriteString("=== file: " + filepath.ToSlash(rel) + " ===\n")
		b.WriteString(f.Content)
		b.WriteString("=== end ===\n")
	}
	warns := append([]string(nil), res.Warnings...)
	sort.Strings(warns)
	for _, w := range warns {
		b.WriteString("=== warning: " + w + "\n")
	}
	return b.String()
}
