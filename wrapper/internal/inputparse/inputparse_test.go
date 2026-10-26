package inputparse

import (
	"reflect"
	"strings"
	"testing"
)

func TestParseSinglePoint(t *testing.T) {
	in := "! wB97X-V def2-QZVPP SMD(Acetonitrile) TightSCF\n" +
		"%maxcore 6000\n" +
		"%pal\n  nprocs 8\nend\n"
	s := Parse(in)
	if s.Functional != "wB97X-V" {
		t.Errorf("Functional = %q, want wB97X-V", s.Functional)
	}
	if s.Basis != "def2-QZVPP" {
		t.Errorf("Basis = %q, want def2-QZVPP", s.Basis)
	}
	if s.SolventModel != "SMD" || s.Solvent != "Acetonitrile" {
		t.Errorf("Solvent = %q/%q, want SMD/Acetonitrile", s.SolventModel, s.Solvent)
	}
	if s.ScfTier != "TIGHTSCF" {
		t.Errorf("ScfTier = %q, want TIGHTSCF", s.ScfTier)
	}
	if s.NProcs != 8 {
		t.Errorf("NProcs = %d, want 8", s.NProcs)
	}
	if s.MaxCoreMB != 6000 {
		t.Errorf("MaxCoreMB = %d, want 6000", s.MaxCoreMB)
	}
	// ORCA's default with no run-type keyword is a single point; the
	// summary labels it as such instead of leaving the job type empty.
	if s.JobType != "SP" {
		t.Errorf("JobType = %q, want SP (ORCA default run type)", s.JobType)
	}
}

func TestParseEmptyTextHasNoJobType(t *testing.T) {
	s := Parse("")
	if s.JobType != "" || len(s.RunTypes) != 0 {
		t.Errorf("empty input: JobType = %q, RunTypes = %v, want unlabeled", s.JobType, s.RunTypes)
	}
}

// A workflow run type names the job even when generic Opt/Freq tokens
// accompany it; pure Opt/Freq combos keep their combined labels.
func TestDeriveJobTypeWorkflowIdentityWins(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{"! XTB2 NEB-TS Freq", "NEB-TS"},
		{"! NEB-CI", "NEB-CI"},
		{"! B3LYP IRC", "IRC"},
		{"! OptTS Freq", "OPTTS_FREQ"},
		{"! Opt Freq", "OPT_FREQ"},
		{"! Freq", "FREQ"},
	}
	for _, c := range cases {
		if got := Parse(c.input + "\n* xyz 0 1\nH 0 0 0\n*\n").JobType.String(); got != c.want {
			t.Errorf("%q: JobType = %q, want %q", c.input, got, c.want)
		}
	}
}

func TestParseOptTSCompositeWithCPCM(t *testing.T) {
	in := "! UKS r2SCAN-3c OptTS Freq CPCM(Acetonitrile)\n" +
		"%maxcore 6000\n" +
		"%pal nprocs=4 end\n"
	s := Parse(in)
	if s.Functional != "r2SCAN-3c" {
		t.Errorf("Functional = %q, want r2SCAN-3c", s.Functional)
	}
	if s.Method != "composite" {
		t.Errorf("Method = %q, want composite", s.Method)
	}
	if !reflect.DeepEqual(s.RunTypes, []RunType{RunTypeOptTS, RunTypeFreq}) {
		t.Errorf("RunTypes = %v, want [OPTTS FREQ]", s.RunTypes)
	}
	if s.JobType != "OPTTS_FREQ" {
		t.Errorf("JobType = %q, want OPTTS_FREQ", s.JobType)
	}
	if s.SolventModel != "CPCM" || s.Solvent != "Acetonitrile" {
		t.Errorf("Solvent = %q/%q", s.SolventModel, s.Solvent)
	}
	if s.NProcs != 4 {
		t.Errorf("NProcs = %d, want 4 (from nprocs=4 syntax)", s.NProcs)
	}
}

func TestParseNProcsPalShorthand(t *testing.T) {
	in := "! HF def2-SVP Opt PAL2\n"
	s := Parse(in)
	if s.NProcs != 2 {
		t.Errorf("NProcs = %d, want 2 (from PAL2)", s.NProcs)
	}
	if s.JobType != "OPT" {
		t.Errorf("JobType = %q, want OPT", s.JobType)
	}
	if s.Method != "HF" {
		t.Errorf("Method = %q, want HF", s.Method)
	}
}

func TestParseGoatEntropyRunType(t *testing.T) {
	in := "! GOAT-Entropy xTB2 ALPB(DMSO)\n" +
		"%pal\n  nprocs 8\nend\n"
	s := Parse(in)
	if !reflect.DeepEqual(s.RunTypes, []RunType{RunTypeGoat}) {
		t.Errorf("RunTypes = %v, want [GOAT]", s.RunTypes)
	}
	if s.JobType != "GOAT" {
		t.Errorf("JobType = %q, want GOAT", s.JobType)
	}
	if s.Method != "XTB2" {
		t.Errorf("Method = %q, want XTB2", s.Method)
	}
	if s.SolventModel != "ALPB" || s.Solvent != "DMSO" {
		t.Errorf("Solvent = %q/%q, want ALPB/DMSO", s.SolventModel, s.Solvent)
	}
}

func TestParseMECPRunType(t *testing.T) {
	in := "! UKS B3LYP def2-SVP MECP TightSCF\n"
	s := Parse(in)
	if !reflect.DeepEqual(s.RunTypes, []RunType{RunTypeMECP}) {
		t.Errorf("RunTypes = %v, want [MECP]", s.RunTypes)
	}
	if s.JobType != "MECP" {
		t.Errorf("JobType = %q, want MECP", s.JobType)
	}
}

func TestOptTierImpliesOpt(t *testing.T) {
	// `! TightOpt` (or VeryTightOpt …) is a standalone run keyword in ORCA:
	// it requests a geometry optimization even without an explicit `Opt`.
	for _, tier := range []string{"TightOpt", "VeryTightOpt", "LooseOpt", "NormalOpt"} {
		s := Parse("! B3LYP def2-SVP " + tier + "\n")
		if !containsAny(s.RunTypes, RunTypeOpt) {
			t.Errorf("%s: RunTypes = %v, want to contain OPT", tier, s.RunTypes)
		}
		if s.JobType != "OPT" {
			t.Errorf("%s: JobType = %q, want OPT", tier, s.JobType)
		}
		if s.OptTier != strings.ToUpper(tier) {
			t.Errorf("%s: OptTier = %q, want %q", tier, s.OptTier, strings.ToUpper(tier))
		}
	}
}

func TestOptTierImpliesOptWithFreq(t *testing.T) {
	s := Parse("! B3LYP def2-SVP VeryTightOpt Freq\n")
	if s.JobType != "OPT_FREQ" {
		t.Errorf("JobType = %q, want OPT_FREQ", s.JobType)
	}
}

func TestOptTierDoesNotOverrideGeometryDriver(t *testing.T) {
	// A tier next to OptTS (or another geometry-driving run type) only tunes
	// its convergence criteria — no extra OPT must be added.
	s := Parse("! B3LYP def2-SVP OptTS TightOpt\n")
	if !reflect.DeepEqual(s.RunTypes, []RunType{RunTypeOptTS}) {
		t.Errorf("RunTypes = %v, want [OPTTS]", s.RunTypes)
	}
	if s.JobType != "OPTTS" {
		t.Errorf("JobType = %q, want OPTTS", s.JobType)
	}
	s = Parse("! XTB GOAT TightOpt\n")
	if !reflect.DeepEqual(s.RunTypes, []RunType{RunTypeGoat}) {
		t.Errorf("RunTypes = %v, want [GOAT]", s.RunTypes)
	}
}

func TestParseChargeMultAndGrid(t *testing.T) {
	in := "! B3LYP def2-SVP Opt Freq TightOpt DefGrid3\n" +
		"* xyz -1 2\n" +
		"O 0.0 0.0 0.0\n" +
		"H 0.0 0.0 1.0\n" +
		"*\n"
	s := Parse(in)
	if s.OptTier != "TIGHTOPT" {
		t.Errorf("OptTier = %q, want TIGHTOPT", s.OptTier)
	}
	if s.Grid != "DEFGRID3" {
		t.Errorf("Grid = %q, want DEFGRID3", s.Grid)
	}
	if s.Charge == nil || *s.Charge != -1 {
		t.Errorf("Charge = %v, want -1", s.Charge)
	}
	if s.Mult == nil || *s.Mult != 2 {
		t.Errorf("Mult = %v, want 2", s.Mult)
	}
}

func TestParseXyzfileChargeMult(t *testing.T) {
	in := "! B97-3c Opt\n" +
		"* xyzfile 0 1 input.xyz\n"
	s := Parse(in)
	if s.Charge == nil || *s.Charge != 0 {
		t.Errorf("Charge = %v, want 0", s.Charge)
	}
	if s.Mult == nil || *s.Mult != 1 {
		t.Errorf("Mult = %v, want 1", s.Mult)
	}
}

func TestParsePopleBasisSets(t *testing.T) {
	cases := []string{
		"6-31G", "6-31G*", "6-31G**", "6-31+G*", "6-31++G**",
		"6-311G", "6-311+G*", "6-311+G**", "6-311++G**",
		"6-31G(d)", "6-31G(d,p)", "6-311+G(2df,2pd)",
		"3-21G", "4-31G",
	}
	for _, basis := range cases {
		in := "! B3LYP " + basis + " Opt\n"
		s := Parse(in)
		if s.Basis != basis {
			t.Errorf("Basis = %q, want %q (functional=%q)", s.Basis, basis, s.Functional)
		}
		if s.Functional != "B3LYP" {
			t.Errorf("for %q: Functional = %q, want B3LYP", basis, s.Functional)
		}
	}
}

func TestParseUnknownTokensPreserved(t *testing.T) {
	in := "! B3LYP def2-TZVP SomeMadeUpToken Opt D3BJ\n"
	s := Parse(in)
	if s.Functional != "B3LYP" {
		t.Errorf("Functional = %q", s.Functional)
	}
	if len(s.Keywords) != 5 {
		t.Errorf("Keywords = %v, want 5 tokens", s.Keywords)
	}
	if !reflect.DeepEqual(s.Corrections, []string{"D3BJ"}) {
		t.Errorf("Corrections = %v", s.Corrections)
	}
}

// The FAST/LOOSE/TIGHT NEB-TS presets differ only in thresholds — they
// must classify as NEB-TS (raw token preserved in Keywords), and the
// linter must recognize them instead of typo-flagging.
func TestParseNEBTSAliasVariants(t *testing.T) {
	for _, kw := range []string{"FAST-NEB-TS", "Loose-NEB-TS", "TIGHT-neb-ts"} {
		s := Parse("! XTB " + kw + "\n*xyzfile 0 1 react.xyz\n")
		if len(s.RunTypes) != 1 || s.RunTypes[0] != RunTypeNEBTS {
			t.Errorf("%s: RunTypes = %v, want [NEB-TS]", kw, s.RunTypes)
		}
		if !IsRecognizedToken(kw) {
			t.Errorf("IsRecognizedToken(%s) = false, want true", kw)
		}
	}
	// Alias + explicit NEB-TS dedups to one entry.
	s := Parse("! XTB NEB-TS FAST-NEB-TS\n")
	if len(s.RunTypes) != 1 {
		t.Errorf("RunTypes = %v, want single NEB-TS entry", s.RunTypes)
	}
	// An opt tier alongside an alias tunes the driver, no extra OPT.
	s = Parse("! XTB TightOpt FAST-NEB-TS\n")
	for _, rt := range s.RunTypes {
		if rt == RunTypeOpt {
			t.Errorf("RunTypes = %v: opt tier must not add OPT next to a NEB driver", s.RunTypes)
		}
	}
}

func TestParseScanTSAndNEBIDPP(t *testing.T) {
	s := Parse("! B3LYP def2-SVP ScanTS\n")
	if len(s.RunTypes) != 1 || s.RunTypes[0] != RunTypeScanTS {
		t.Errorf("ScanTS: RunTypes = %v, want [SCANTS]", s.RunTypes)
	}
	s = Parse("! XTB NEB-IDPP\n")
	if len(s.RunTypes) != 1 || s.RunTypes[0] != RunTypeNEBIDPP {
		t.Errorf("NEB-IDPP: RunTypes = %v, want [NEB-IDPP]", s.RunTypes)
	}
}
