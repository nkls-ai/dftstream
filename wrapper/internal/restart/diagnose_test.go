package restart

import (
	"compress/gzip"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/nkls-ai/dftstream/internal/parser"
)

// The failure fixtures live with the parser — the classifier under test
// IS the parser's; restart only folds its verdict.
const parserTestdata = "../parser/testdata"

func readParserFixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(parserTestdata, name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return string(b)
}

// TestDiagnoseOutputVerdictPerFixture pins the run-level verdict for every
// failure-catalogue fixture: one fixture per ErrorClass (the coverage of
// the catalogue itself is pinned in the parser's corpus tests).
func TestDiagnoseOutputVerdictPerFixture(t *testing.T) {
	cases := []struct {
		file string
		want parser.ErrorClass
	}{
		{"orca5_scf_not_converged.out", parser.ErrorClassSCFNotConverged},
		{"orca6_scf_not_converged.out", parser.ErrorClassSCFNotConverged},
		{"orca6_out_of_memory.out", parser.ErrorClassOutOfMemory},
		{"orca6_disk_or_scratch.out", parser.ErrorClassDiskOrScratch},
		{"orca6_geometry_exploded.out", parser.ErrorClassGeometryExploded},
		{"orca6_charge_mult_impossible.out", parser.ErrorClassChargeMultImpossible},
		{"orca6_unstable_wavefunction.out", parser.ErrorClassUnstableWavefunction},
		{"orca6_basis_or_ecp_missing.out", parser.ErrorClassBasisOrECPMissing},
		// A module died mid-run and ORCA still printed its normal banner:
		// the hard failure survives the clean-run gate.
		{"orca6_external_tool_failed.out", parser.ErrorClassExternalToolFailed},
		{"orca6_input_error.out", parser.ErrorClassInputError},
		{"orca6_opt_max_cycles.out", parser.ErrorClassOptMaxCycles},
		{"orca6_unknown_abort.out", parser.ErrorClassUnknown},
		// A recovered instability on a normally-terminated run is NOT a
		// failure — same rule the runner applies.
		{"orca6_recovered_instability.out", ""},
		{"orca6_clean_near_misses.out", ""},
	}
	for _, tc := range cases {
		t.Run(tc.file, func(t *testing.T) {
			diag, err := DiagnoseOutput(readParserFixture(t, tc.file), false)
			if err != nil {
				t.Fatalf("DiagnoseOutput: %v", err)
			}
			if diag.Class != tc.want {
				t.Errorf("class = %q, want %q", diag.Class, tc.want)
			}
			if tc.want != "" && diag.Excerpt == "" {
				t.Errorf("no excerpt captured for %q", tc.want)
			}
		})
	}
}

func TestDiagnoseOutputKeepsFailingSCFTrace(t *testing.T) {
	diag, err := DiagnoseOutput(readParserFixture(t, "orca6_scf_not_converged.out"), false)
	if err != nil {
		t.Fatal(err)
	}
	if len(diag.LastSCFEnergies) != 2 {
		t.Fatalf("LastSCFEnergies = %v, want the fixture's 2 iterations", diag.LastSCFEnergies)
	}
	if diag.LastSCFEnergies[0] != -75.95 || diag.LastSCFEnergies[1] != -75.955 {
		t.Errorf("LastSCFEnergies = %v", diag.LastSCFEnergies)
	}
}

// TestDiagnoseOutputLastSCFTableWins: an Opt run holds many SCF tables;
// only the final (failing) one may drive the stage-2 trend choice.
func TestDiagnoseOutputLastSCFTableWins(t *testing.T) {
	out := `Program Version 6.1.0
                        ----------------------------
                                    D-I-I-S
                        ----------------------------
  Iteration    Energy (Eh)           Delta-E    RMSDP     MaxDP     DIISErr   Damp  Time(sec)
    1    -75.0000000000000000     0.00e+00  3.77e-03  7.50e-02  1.45e-01  0.700   2.1
    2    -75.1000000000000000    -1.00e-01  1.20e-03  2.10e-02  4.50e-02  0.700   2.0

               *****************************************************
               *                     SUCCESS                       *
               *           SCF CONVERGED AFTER  2 CYCLES           *
               *****************************************************

                        ----------------------------
                                    D-I-I-S
                        ----------------------------
  Iteration    Energy (Eh)           Delta-E    RMSDP     MaxDP     DIISErr   Damp  Time(sec)
    1    -75.2000000000000000     0.00e+00  3.77e-03  7.50e-02  1.45e-01  0.700   2.1
    2    -75.3000000000000000    -1.00e-01  1.20e-03  2.10e-02  4.50e-02  0.700   2.0
    3    -75.3500000000000000    -5.00e-02  1.20e-03  2.10e-02  4.50e-02  0.700   2.0

Error (ORCA_LEANSCF): unfortunately, the SCF has not converged. There may be a way out but we have to stop here
[file orca_main/run.cpp, line 1547]: ORCA finished with error return - aborting the run
`
	diag, err := DiagnoseOutput(out, false)
	if err != nil {
		t.Fatal(err)
	}
	if diag.Class != parser.ErrorClassSCFNotConverged {
		t.Fatalf("class = %q", diag.Class)
	}
	want := []float64{-75.2, -75.3, -75.35}
	if len(diag.LastSCFEnergies) != len(want) {
		t.Fatalf("LastSCFEnergies = %v, want the last table only (%v)", diag.LastSCFEnergies, want)
	}
	for i, w := range want {
		if diag.LastSCFEnergies[i] != w {
			t.Fatalf("LastSCFEnergies = %v, want %v", diag.LastSCFEnergies, want)
		}
	}
}

// TestDiagnoseOutputCleanCorpusRun runs a real gzipped corpus output
// through the same path the CLI uses: a converged Opt Freq must come back
// with no error class and ActionNone.
func TestDiagnoseOutputCleanCorpusRun(t *testing.T) {
	path := filepath.Join(parserTestdata, "corpus/6.1/water_hf_def2svp_opt_freq.out.gz")
	f, err := os.Open(path)
	if err != nil {
		if os.Getenv("DFTSTREAM_REQUIRE_CORPUS") != "" {
			t.Fatalf("fixture missing and DFTSTREAM_REQUIRE_CORPUS is set: %v", err)
		}
		t.Skipf("corpus fixture not in this checkout: %v", err)
	}
	defer func() {
		if err := f.Close(); err != nil {
			t.Errorf("close %s: %v", path, err)
		}
	}()
	zr, err := gzip.NewReader(f)
	if err != nil {
		t.Fatalf("gzip %s: %v", path, err)
	}
	defer func() {
		// Close also verifies the gzip checksum — an error here means the
		// fixture is corrupt, not that cleanup failed.
		if err := zr.Close(); err != nil {
			t.Errorf("gzip close %s: %v", path, err)
		}
	}()
	text, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}

	diag, err := DiagnoseOutput(string(text), false)
	if err != nil {
		t.Fatalf("DiagnoseOutput: %v", err)
	}
	if diag.Class != "" {
		t.Fatalf("clean corpus run classified as %q (excerpt: %s)", diag.Class, diag.Excerpt)
	}
	a := AnalyzeOutput(string(text))
	if got := Decide(diag.Class, a, true, false); got != ActionNone {
		t.Errorf("Decide on clean corpus run = %s, want %s", got, ActionNone)
	}
}
