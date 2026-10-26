package followup

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nkls-ai/dftstream/internal/inputparse"
	"github.com/nkls-ai/dftstream/internal/restart"
)

// mkSource builds a Source from inline input/output texts, materialized in
// dir so sibling-file lookups (.hess, IRC trajectories) work.
func mkSource(t *testing.T, dir, name, inp, out string) Source {
	t.Helper()
	stem := filepath.Join(dir, name)
	if err := os.WriteFile(stem+".inp", []byte(inp), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stem+".out", []byte(out), 0o644); err != nil {
		t.Fatal(err)
	}
	return Source{
		OutPath:  stem + ".out",
		Stem:     stem,
		Summary:  inputparse.Parse(inp),
		Analysis: restart.AnalyzeOutput(out),
	}
}

const convergedMinOut = `
---------------------------------
CARTESIAN COORDINATES (ANGSTROEM)
---------------------------------
  C     0.000000    0.000000    0.000000
  N     0.000000    0.000000    1.160000
  H     0.000000    0.000000   -1.070000

                    ***        THE OPTIMIZATION HAS CONVERGED     ***

---------------------------------
CARTESIAN COORDINATES (ANGSTROEM)
---------------------------------
  C     0.000000    0.000000    0.010000
  N     0.000000    0.000000    1.170000
  H     0.000000    0.000000   -1.060000

-----------------------
VIBRATIONAL FREQUENCIES
-----------------------

     6:      210.11 cm**-1
                             ****ORCA TERMINATED NORMALLY****
`

const convergedTSOut = `
---------------------------------
CARTESIAN COORDINATES (ANGSTROEM)
---------------------------------
  C     0.100000    0.000000    0.000000
  N     0.000000    0.100000    1.160000
  H     0.500000    0.500000    0.000000

                    ***        THE OPTIMIZATION HAS CONVERGED     ***

-----------------------
VIBRATIONAL FREQUENCIES
-----------------------

     6:     -450.31 cm**-1  ***imaginary mode***
     7:     1800.00 cm**-1
                             ****ORCA TERMINATED NORMALLY****
`

func TestNebTSGenerator(t *testing.T) {
	dir := t.TempDir()
	reactant := mkSource(t, dir, "hcn", "! XTB Opt Freq TightSCF\n%pal nprocs 4 end\n* xyz 0 1\nC 0 0 0\nN 0 0 1.16\nH 0 0 -1.07\n*\n", convergedMinOut)
	product := mkSource(t, dir, "hnc", "! XTB Opt Freq TightSCF\n* xyz 0 1\nC 0 0 0\nN 0 0 1.16\nH 0 0 2.16\n*\n", convergedMinOut)

	res, err := Registry["neb-ts"].Generate(Request{Sources: []Source{reactant, product}, NImages: 12})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Files) != 3 {
		t.Fatalf("files = %d, want 3 (input + both endpoint xyz)", len(res.Files))
	}
	inp := res.Files[0].Content
	for _, want := range []string{
		"# dftstream: edge=neb-ts parent=",
		"! XTB TightSCF NEB-TS Freq\n",
		"%pal nprocs 4 end\n",
		"NEB_End_XYZFile \"hcn_neb-ts_product.xyz\"",
		"Nimages 12",
		// ORCA's NEB aborts on an inline starting structure — both
		// endpoints must be referenced as files.
		"* xyzfile 0 1 hcn_neb-ts_reactant.xyz\n",
	} {
		if !strings.Contains(inp, want) {
			t.Errorf("neb-ts input missing %q in:\n%s", want, inp)
		}
	}
	if strings.Contains(inp, "* xyz 0 1\n") {
		t.Errorf("neb-ts input must not inline the starting geometry:\n%s", inp)
	}
	if !strings.HasSuffix(res.Files[1].Path, "_neb-ts_reactant.xyz") || !strings.HasSuffix(res.Files[2].Path, "_neb-ts_product.xyz") {
		t.Errorf("endpoint xyz paths = %s, %s", res.Files[1].Path, res.Files[2].Path)
	}
	for _, f := range res.Files[1:] {
		if !strings.HasPrefix(f.Content, "3\n") {
			t.Errorf("%s must start with the atom count:\n%s", f.Path, f.Content)
		}
	}
}

func TestNebTSGeneratorRefusesMismatchedSystems(t *testing.T) {
	dir := t.TempDir()
	reactant := mkSource(t, dir, "r", "! XTB Opt\n* xyz 0 1\nC 0 0 0\n*\n", convergedMinOut)
	product := mkSource(t, dir, "p", "! XTB Opt\n* xyz -1 2\nC 0 0 0\n*\n", convergedMinOut)
	_, err := Registry["neb-ts"].Generate(Request{Sources: []Source{reactant, product}})
	if err == nil || !strings.Contains(err.Error(), "charge/multiplicity") {
		t.Fatalf("want charge/mult mismatch error, got %v", err)
	}
}

func TestIRCGenerator(t *testing.T) {
	dir := t.TempDir()
	ts := mkSource(t, dir, "ts", "! XTB OptTS Freq\n* xyz 0 1\nC 0 0 0\nN 0 0 1.16\nH 0 0 -1.07\n*\n", convergedTSOut)
	if err := os.WriteFile(ts.Stem+".hess", []byte("$hessian\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	res, err := Registry["irc"].Generate(Request{Sources: []Source{ts}})
	if err != nil {
		t.Fatal(err)
	}
	inp := res.Files[0].Content
	for _, want := range []string{
		"edge=irc",
		"! XTB IRC\n",
		"InitHess Read",
		"Hess_Filename \"ts.hess\"",
	} {
		if !strings.Contains(inp, want) {
			t.Errorf("irc input missing %q in:\n%s", want, inp)
		}
	}
	if strings.Contains(inp, "OptTS") || strings.Contains(inp, "Freq") {
		t.Errorf("irc input must strip the TS/freq job keywords:\n%s", inp)
	}
}

func TestIRCGeneratorRefusesWithoutSingleImagMode(t *testing.T) {
	dir := t.TempDir()
	minimum := mkSource(t, dir, "min", "! XTB OptTS Freq\n* xyz 0 1\nC 0 0 0\n*\n", convergedMinOut)
	_, err := Registry["irc"].Generate(Request{Sources: []Source{minimum}})
	if err == nil || !strings.Contains(err.Error(), "imaginary modes") {
		t.Fatalf("want imaginary-mode refusal, got %v", err)
	}
	// -f overrides.
	if _, err := Registry["irc"].Generate(Request{Sources: []Source{minimum}, Force: true}); err != nil {
		t.Fatalf("force should override the refusal: %v", err)
	}
}

func TestOptEndpointsGenerator(t *testing.T) {
	dir := t.TempDir()
	irc := mkSource(t, dir, "irc", "! XTB IRC\n* xyz 0 1\nC 0 0 0\nN 0 0 1.16\nH 0 0 -1.07\n*\n", convergedTSOut)
	trj := "3\nframe 1\nC 0.0 0.0 0.0\nN 0.0 0.0 1.16\nH 0.0 0.0 -1.07\n3\nframe 2\nC 0.0 0.0 0.5\nN 0.0 0.0 1.5\nH 0.0 0.0 -0.5\n"
	if err := os.WriteFile(irc.Stem+"_IRC_F_trj.xyz", []byte(trj), 0o644); err != nil {
		t.Fatal(err)
	}

	res, err := Registry["opt-endpoints"].Generate(Request{Sources: []Source{irc}})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Files) != 1 {
		t.Fatalf("files = %d, want 1 (only forward trajectory present)", len(res.Files))
	}
	if len(res.Warnings) != 1 || !strings.Contains(res.Warnings[0], "_IRC_B_trj.xyz") {
		t.Errorf("want missing-backward warning, got %v", res.Warnings)
	}
	inp := res.Files[0].Content
	for _, want := range []string{
		"edge=endpoint-opt",
		"! XTB Opt Freq\n",
		// Last frame of the trajectory, not the first.
		"C       0.00000000     0.00000000     0.50000000",
	} {
		if !strings.Contains(inp, want) {
			t.Errorf("endpoint input missing %q in:\n%s", want, inp)
		}
	}
	if strings.Contains(inp, "IRC") && strings.Contains(inp, "! XTB Opt Freq IRC") {
		t.Errorf("IRC keyword must be stripped:\n%s", inp)
	}
}

func TestSPGenerator(t *testing.T) {
	dir := t.TempDir()
	src := mkSource(t, dir, "min", "! r2SCAN-3c Opt Freq CPCM(water)\n%maxcore 4000\n* xyz 0 1\nC 0 0 0\nN 0 0 1.16\nH 0 0 -1.07\n*\n", convergedMinOut)

	res, err := Registry["sp"].Generate(Request{Sources: []Source{src}, Method: "! DLPNO-CCSD(T) cc-pVTZ cc-pVTZ/C TightSCF"})
	if err != nil {
		t.Fatal(err)
	}
	inp := res.Files[0].Content
	for _, want := range []string{
		"edge=sp",
		"! DLPNO-CCSD(T) cc-pVTZ cc-pVTZ/C TightSCF CPCM(water)\n",
		"%maxcore 4000\n",
	} {
		if !strings.Contains(inp, want) {
			t.Errorf("sp input missing %q in:\n%s", want, inp)
		}
	}
	if strings.Contains(inp, "r2SCAN-3c") {
		t.Errorf("sp input must not keep the parent method:\n%s", inp)
	}

	// No method anywhere → hard error.
	if _, err := Registry["sp"].Generate(Request{Sources: []Source{src}}); err == nil {
		t.Fatal("want error when no method is provided")
	}
}

func TestLastXYZFrameTruncatedTail(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "t.xyz")
	// Second frame is truncated — the first complete frame must win.
	content := "2\nok\nH 0.0 0.0 0.0\nH 0.0 0.0 0.7\n2\ntruncated\nH 1.0 1.0 1.0\n"
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	frame, err := lastXYZFrame(p)
	if err != nil {
		t.Fatal(err)
	}
	if len(frame) != 2 || frame[1].Z != 0.7 {
		t.Fatalf("frame = %+v, want the first complete frame", frame)
	}
}

func TestOptEndpointsFallsBackToFullTrajectory(t *testing.T) {
	dir := t.TempDir()
	irc := mkSource(t, dir, "irc", "! XTB IRC\n* xyz 0 1\nH 0 0 0\nH 0 0 0.7\n*\n", convergedTSOut)
	full := "2\nendpoint A\nH 0.0 0.0 0.0\nH 0.0 0.0 0.7\n2\nTS-ish middle\nH 0.0 0.0 0.2\nH 0.0 0.0 0.9\n2\nendpoint B\nH 0.0 0.0 0.4\nH 0.0 0.0 1.1\n"
	if err := os.WriteFile(irc.Stem+"_IRC_Full_trj.xyz", []byte(full), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := Registry["opt-endpoints"].Generate(Request{Sources: []Source{irc}})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Files) != 2 {
		t.Fatalf("files = %d, want 2 endpoints from the Full trajectory", len(res.Files))
	}
	if !strings.Contains(res.Files[0].Content, "0.00000000     0.00000000     0.00000000") {
		t.Errorf("ep1 must be the FIRST frame:\n%s", res.Files[0].Content)
	}
	if !strings.Contains(res.Files[1].Content, "0.00000000     0.00000000     0.40000000") {
		t.Errorf("ep2 must be the LAST frame:\n%s", res.Files[1].Content)
	}
	if len(res.Warnings) == 0 {
		t.Error("want a fallback warning")
	}
}
