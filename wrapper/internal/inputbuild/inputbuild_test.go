package inputbuild

import (
	"strings"
	"testing"

	"github.com/nkls-ai/dftstream/internal/inputparse"
)

func TestRenderInlineGeometry(t *testing.T) {
	in := Input{
		Comments: []string{"# dftstream: edge=sp parent=\"exp/run\"\n"},
		Keywords: []string{"r2SCAN-3c", "Opt", "Freq"},
		Env:      Environment{Charge: -1, Mult: 2, Model: SolventCPCM, Solvent: "water"},
		Res:      Resources{NProcs: 8, MaxCoreMB: 3000},
		Blocks:   []Block{GeomBlock{CalcHess: true}},
		Structure: Geometry{
			{El: "O", X: 0, Y: 0, Z: 0},
			{El: "H", X: 0.9, Y: 0, Z: 0},
		},
	}
	want := `# dftstream: edge=sp parent="exp/run"
! r2SCAN-3c Opt Freq
%pal nprocs 8 end
%maxcore 3000
%geom
  Calc_Hess true
end
* xyz -1 2
O       0.00000000     0.00000000     0.00000000
H       0.90000000     0.00000000     0.00000000
*
`
	if got := in.Render(); got != want {
		t.Errorf("render mismatch\n--- want ---\n%s\n--- got ---\n%s", want, got)
	}
}

func TestRenderXYZFileAndOmittedResources(t *testing.T) {
	in := Input{
		Keywords:  []string{"XTB", "NEB-TS", "Freq"},
		Env:       DefaultEnvironment(),
		Blocks:    []Block{NEBBlock{EndXYZFile: "p.xyz"}},
		Structure: XYZFile("r.xyz"),
	}
	want := `! XTB NEB-TS Freq
%neb
  NEB_End_XYZFile "p.xyz"
  Nimages 8
end
* xyzfile 0 1 r.xyz
`
	if got := in.Render(); got != want {
		t.Errorf("render mismatch\n--- want ---\n%s\n--- got ---\n%s", want, got)
	}
}

func TestEmptyBlocksAreSkipped(t *testing.T) {
	in := Input{
		Keywords: []string{"XTB"},
		Env:      DefaultEnvironment(),
		// Every one of these renders nothing when unconfigured; an
		// accidental blank line here would land in a cluster input.
		Blocks: []Block{IRCBlock{}, GeomBlock{}, SCFBlock{}, CPCMBlock{}, TDDFTBlock{}, MECPBlock{}, FreqBlock{}, RawBlock("")},
	}
	if got := in.Render(); got != "! XTB\n" {
		t.Errorf("render = %q, want only the keyword line", got)
	}
}

func TestRawBlockGetsTrailingNewline(t *testing.T) {
	in := Input{Keywords: []string{"XTB"}, Env: DefaultEnvironment(),
		Blocks: []Block{RawBlock("%geom Calc_Hess true end"), RawBlock("%scf MaxIter 300 end\n")}}
	want := "! XTB\n%geom Calc_Hess true end\n%scf MaxIter 300 end\n"
	if got := in.Render(); got != want {
		t.Errorf("render = %q, want %q", got, want)
	}
}

func TestRenderScanJob(t *testing.T) {
	in := Input{
		Keywords: []string{"XTB2", "Opt"},
		Env:      DefaultEnvironment(),
		Blocks: []Block{GeomBlock{Scans: []ScanDimension{
			{Coord: ScanBond, Atoms: []int{0, 1}, From: 1.1, To: 1.8, Steps: 15},
		}}},
		Structure: Geometry{{El: "O"}, {El: "C", Z: 1.203}},
	}
	// Matches the group's own scan inputs (.examples/surfscan_h2co_xtb).
	want := `! XTB2 Opt
%geom
  Scan
    B 0 1 = 1.10, 1.80, 15
  end
end
* xyz 0 1
O       0.00000000     0.00000000     0.00000000
C       0.00000000     0.00000000     1.20300000
*
`
	if got := in.Render(); got != want {
		t.Errorf("render mismatch\n--- want ---\n%s\n--- got ---\n%s", want, got)
	}
}

func TestScanDimensionRender(t *testing.T) {
	cases := []struct {
		dim  ScanDimension
		want string
	}{
		{ScanDimension{Coord: ScanAngle, Atoms: []int{0, 1, 2}, From: 100, To: 120.5, Steps: 11},
			"A 0 1 2 = 100.00, 120.50, 11"},
		{ScanDimension{Coord: ScanDihedral, Atoms: []int{3, 2, 1, 0}, From: -180, To: 180, Steps: 37},
			"D 3 2 1 0 = -180.00, 180.00, 37"},
		{ScanDimension{Coord: ScanBond, Atoms: []int{0, 1}, From: 1.075, To: 2.125, Steps: 8},
			"B 0 1 = 1.075, 2.125, 8"},
	}
	for _, tc := range cases {
		if got := tc.dim.Render(); got != tc.want {
			t.Errorf("scan render = %q, want %q", got, tc.want)
		}
	}
	if n, ok := ScanAtomCount(ScanDihedral); !ok || n != 4 {
		t.Errorf("ScanAtomCount(D) = %d, %v", n, ok)
	}
	if _, ok := ScanAtomCount(ScanCoord("X")); ok {
		t.Error("unknown scan coordinate must be rejected")
	}
}

func TestRenderTDDFTJob(t *testing.T) {
	in := Input{
		Keywords:  []string{"wB97X-D4", "def2-TZVP", "TightSCF", "DEFGRID3"},
		Env:       DefaultEnvironment(),
		Blocks:    []Block{TDDFTBlock{NRoots: 8, Triplets: true}},
		Structure: Geometry{{El: "H"}, {El: "H", Z: 0.74}},
	}
	want := `! wB97X-D4 def2-TZVP TightSCF DEFGRID3
%tddft
  NRoots 8
  Triplets true
end
* xyz 0 1
H       0.00000000     0.00000000     0.00000000
H       0.00000000     0.00000000     0.74000000
*
`
	if got := in.Render(); got != want {
		t.Errorf("render mismatch\n--- want ---\n%s\n--- got ---\n%s", want, got)
	}
	if got := (TDDFTBlock{Triplets: true}).Render(); got != "" {
		t.Errorf("a %%tddft block without NRoots must render nothing, got %q", got)
	}
	if got := (TDDFTBlock{NRoots: 5}).Render(); got != "%tddft\n  NRoots 5\nend" {
		t.Errorf("singlet-only tddft block = %q", got)
	}
}

func TestRenderNMRJob(t *testing.T) {
	in := Input{
		Keywords:  KeywordsFor([]string{"wB97X-D4", "def2-TZVP"}, JobNMR),
		Env:       DefaultEnvironment(),
		Structure: XYZFile("mol.xyz"),
	}
	want := "! wB97X-D4 def2-TZVP NMR\n* xyzfile 0 1 mol.xyz\n"
	if got := in.Render(); got != want {
		t.Errorf("render = %q, want %q", got, want)
	}
}

func TestRenderMECPJob(t *testing.T) {
	in := Input{
		Keywords:  []string{"UKS", "B3LYP", "def2-SVP", "MECP"},
		Env:       Environment{Charge: 0, Mult: 1},
		Blocks:    []Block{MECPBlock{Mult2: 3}},
		Structure: Geometry{{El: "O"}, {El: "O", Z: 1.2}},
	}
	want := `! UKS B3LYP def2-SVP MECP
%mecp
  Mult 3
end
* xyz 0 1
O       0.00000000     0.00000000     0.00000000
O       0.00000000     0.00000000     1.20000000
*
`
	if got := in.Render(); got != want {
		t.Errorf("render mismatch\n--- want ---\n%s\n--- got ---\n%s", want, got)
	}
	if got := (MECPBlock{}).Render(); got != "" {
		t.Errorf("a %%mecp block without a second multiplicity must render nothing, got %q", got)
	}
}

func TestFreqBlockThermoConditions(t *testing.T) {
	if got := (FreqBlock{}).Render(); got != "" {
		t.Errorf("unset thermo conditions must render nothing (ORCA's defaults stay ORCA's), got %q", got)
	}
	want := "%freq\n  Temp 310.15\n  Pressure 2.50\nend"
	if got := (FreqBlock{TemperatureK: 310.15, PressureAtm: 2.5}).Render(); got != want {
		t.Errorf("freq block = %q, want %q", got, want)
	}
	if got := (FreqBlock{TemperatureK: 273.15}).Render(); got != "%freq\n  Temp 273.15\nend" {
		t.Errorf("temp-only freq block = %q", got)
	}
}

func TestGeomBlockConstraints(t *testing.T) {
	want := "%geom\n  MaxIter 200\n  Constraints\n    { B 0 1 C }\n  end\nend"
	got := GeomBlock{MaxIter: 200, Constraints: []string{"{ B 0 1 C }"}}.Render()
	if got != want {
		t.Errorf("constraints block = %q, want %q", got, want)
	}
}

func TestSolventKeyword(t *testing.T) {
	cases := []struct {
		env  Environment
		want string
	}{
		{Environment{}, ""},
		{Environment{Model: SolventCPCM}, ""}, // no solvent name → no call
		{Environment{Model: SolventCPCM, Solvent: "water"}, "CPCM(water)"},
		{Environment{Model: SolventSMD, Solvent: "Acetonitrile"}, "SMD(Acetonitrile)"},
		{Environment{Model: SolventALPB, Solvent: "thf"}, "ALPB(thf)"},
	}
	for _, tc := range cases {
		if got := tc.env.SolventKeyword(); got != tc.want {
			t.Errorf("%+v: solvent keyword = %q, want %q", tc.env, got, tc.want)
		}
	}
}

func TestParseSolventModelKeepsHyphenSpelling(t *testing.T) {
	// A derived input must reproduce the parent's keyword exactly.
	m, ok := ParseSolventModel("c-pcm")
	if !ok || m != SolventCPCMHyphen {
		t.Errorf("ParseSolventModel(c-pcm) = %q, %v", m, ok)
	}
	if _, ok := ParseSolventModel("COSMO"); ok {
		t.Error("unknown model must not be accepted — it would become a keyword ORCA rejects")
	}
}

func TestHasSolventCall(t *testing.T) {
	if !HasSolventCall([]string{"B3LYP", "CPCM(water)"}) {
		t.Error("parameterized call not detected")
	}
	if !HasSolventCall([]string{"XTB", "alpb(thf)"}) {
		t.Error("lowercase call not detected")
	}
	if HasSolventCall([]string{"r2SCAN-3c", "Opt"}) {
		t.Error("gas-phase keywords reported as solvated")
	}
}

func TestFromSummary(t *testing.T) {
	s := inputparse.Parse("! r2SCAN-3c Opt Freq SMD(Acetonitrile)\n%pal nprocs 12 end\n%maxcore 3000\n* xyz -2 3\nC 0 0 0\n*\n")
	env, res := FromSummary(s)
	if env.Charge != -2 || env.Mult != 3 {
		t.Errorf("env charge/mult = %d/%d, want -2/3", env.Charge, env.Mult)
	}
	if env.SolventKeyword() != "SMD(Acetonitrile)" {
		t.Errorf("solvent = %q", env.SolventKeyword())
	}
	if res.NProcs != 12 || res.MaxCoreMB != 3000 {
		t.Errorf("resources = %+v", res)
	}
}

func TestFromSummaryDefaultsWhenUnparsed(t *testing.T) {
	env, res := FromSummary(inputparse.Parse("! XTB Opt\n"))
	if env.Charge != 0 || env.Mult != 1 {
		t.Errorf("want ORCA's neutral-singlet default, got %+v", env)
	}
	if res.Render() != "" {
		t.Errorf("unset resources must render nothing, got %q", res.Render())
	}
}

func TestXYZFileText(t *testing.T) {
	got := XYZFileText("hello", []Atom{{El: "H"}, {El: "H", Z: 0.74}})
	want := "2\nhello\nH       0.00000000     0.00000000     0.00000000\nH       0.00000000     0.00000000     0.74000000\n"
	if got != want {
		t.Errorf("xyz = %q, want %q", got, want)
	}
	if !strings.HasPrefix(got, "2\n") {
		t.Error("xyz must start with the atom count")
	}
}
