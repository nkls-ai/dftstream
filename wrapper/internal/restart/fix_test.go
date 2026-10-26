package restart

import (
	"strings"
	"testing"

	"github.com/nkls-ai/dftstream/internal/inputbuild"
	"github.com/nkls-ai/dftstream/internal/inputlint"
	"github.com/nkls-ai/dftstream/internal/inputparse"
	"github.com/nkls-ai/dftstream/internal/parser"
)

// ---------------------------------------------------------------------------
// Class coverage: every parser.ErrorClass must be handled deliberately —
// a fix, an explicit transient policy, or an explicit refusal. This is
// the drift guard against ui/src/lib/diagnosis.ts: the buckets below
// mirror its remedy kinds, and a class added to the parser without a
// bucket (or a ClassInfo entry) fails here.
// ---------------------------------------------------------------------------

var fixableClasses = map[parser.ErrorClass]FixAction{
	parser.ErrorClassOptMaxCycles:         ActionOptRestart,
	parser.ErrorClassSCFNotConverged:      ActionFixSCF,
	parser.ErrorClassOutOfMemory:          ActionFixMemory,
	parser.ErrorClassUnstableWavefunction: ActionFixStability,
}

var transientClasses = []parser.ErrorClass{
	parser.ErrorClassDiskOrScratch,
	parser.ErrorClassExternalToolFailed,
	parser.ErrorClassUnknown,
}

var unfixableClasses = []parser.ErrorClass{
	parser.ErrorClassChargeMultImpossible,
	parser.ErrorClassBasisOrECPMissing,
	parser.ErrorClassInputError,
	parser.ErrorClassGeometryExploded,
}

func TestDecideCoversEveryErrorClass(t *testing.T) {
	if n := len(fixableClasses) + len(transientClasses) + len(unfixableClasses); n != len(parser.AllErrorClasses) {
		t.Fatalf("buckets cover %d classes, parser has %d — update the partition", n, len(parser.AllErrorClasses))
	}
	bare := Analysis{} // no geometry, nothing converged
	for class, want := range fixableClasses {
		if got := Decide(class, bare, true, false); got != want {
			t.Errorf("Decide(%s) = %s, want %s", class, got, want)
		}
	}
	for _, class := range transientClasses {
		if got := Decide(class, bare, true, false); got != ActionRerunTransient {
			t.Errorf("Decide(%s) with no geometry = %s, want %s", class, got, ActionRerunTransient)
		}
		// With a converged optimization there IS completed work to keep:
		// the transient failure becomes a Freq-only restart.
		conv := Analysis{OptConverged: true, LastGeometry: []Atom{{El: "O"}}}
		if got := Decide(class, conv, true, false); got != ActionFreqRestart {
			t.Errorf("Decide(%s) with converged opt = %s, want %s", class, got, ActionFreqRestart)
		}
	}
	for _, class := range unfixableClasses {
		if got := Decide(class, bare, true, false); got != ActionNotFixable {
			t.Errorf("Decide(%s) = %s, want %s", class, got, ActionNotFixable)
		}
	}
	// A class from a newer parser this build predates must refuse, not
	// guess.
	if got := Decide(parser.ErrorClass("some_future_class"), bare, true, false); got != ActionNotFixable {
		t.Errorf("Decide(future class) = %s, want %s", got, ActionNotFixable)
	}
}

func TestDecideCleanRunFallsBackToTriage(t *testing.T) {
	cases := []struct {
		name     string
		a        Analysis
		optJob   bool
		expectTS bool
		want     FixAction
	}{
		{"clean minimum", Analysis{Terminated: true, OptConverged: true}, true, false, ActionNone},
		{"minimum with imag", Analysis{Terminated: true, OptConverged: true, ImagModes: []ImagMode{{Index: 6, FreqCM: -65}}}, true, false, ActionKickImag},
		{"freq step died", Analysis{OptConverged: true}, true, false, ActionFreqRestart},
		{"opt crashed", Analysis{}, true, false, ActionOptRestart},
	}
	for _, c := range cases {
		if got := Decide("", c.a, c.optJob, c.expectTS); got != c.want {
			t.Errorf("%s: Decide = %s, want %s", c.name, got, c.want)
		}
	}
}

func TestClassInfoCoversEveryClass(t *testing.T) {
	for _, c := range parser.AllErrorClasses {
		info, ok := ClassInfoFor(c)
		if !ok {
			t.Errorf("no ClassInfo for %q", c)
			continue
		}
		if info.Title == "" || info.Cause == "" {
			t.Errorf("ClassInfo for %q is missing title or cause", c)
		}
		// The unfixable and transient classes must tell the user the next
		// step; the auto-fixed ones explain themselves in the fix notes.
		for _, u := range unfixableClasses {
			if c == u && info.Hint == "" {
				t.Errorf("unfixable class %q has no hint", c)
			}
		}
	}
	if _, ok := ClassInfoFor(""); ok {
		t.Error("the empty class should have no ClassInfo")
	}
	if _, ok := ClassInfoFor("some_future_class"); ok {
		t.Error("an unknown class should have no ClassInfo")
	}
}

// ---------------------------------------------------------------------------
// SCF fix
// ---------------------------------------------------------------------------

func countTokens(kws []string, ups ...string) int {
	n := 0
	for _, k := range kws {
		for _, up := range ups {
			if strings.EqualFold(k, up) {
				n++
			}
		}
	}
	return n
}

func TestSCFFixStages(t *testing.T) {
	orig := []string{"r2SCAN-3c", "Opt"}

	stage1 := SCFFix(orig, TrendUnknown)
	if !hasToken(stage1.Keywords, "SLOWCONV") {
		t.Errorf("stage 1 keywords = %v, want SlowConv", stage1.Keywords)
	}
	if len(stage1.Blocks) != 1 || !strings.Contains(stage1.Blocks[0], "MaxIter 500") {
		t.Errorf("stage 1 blocks = %v, want %%scf MaxIter 500", stage1.Blocks)
	}
	if len(stage1.Comments) == 0 || !strings.Contains(stage1.Comments[0], "stage 1") {
		t.Errorf("stage 1 must say which stage it is in the input: %v", stage1.Comments)
	}

	osc := SCFFix(stage1.Keywords, TrendOscillating)
	if !hasToken(osc.Keywords, "VERYSLOWCONV") || hasToken(osc.Keywords, "SLOWCONV") {
		t.Errorf("stage 2 keywords = %v, want VerySlowConv replacing SlowConv", osc.Keywords)
	}
	if !strings.Contains(strings.Join(osc.Blocks, "\n"), "Shift Shift") {
		t.Errorf("oscillating trace should choose a level shift, got %v", osc.Blocks)
	}

	desc := SCFFix(stage1.Keywords, TrendDescending)
	if !strings.Contains(strings.Join(desc.Blocks, "\n"), "Damp Fac") {
		t.Errorf("descending trace should choose damping, got %v", desc.Blocks)
	}

	// Idempotence: fixing an already-fixed input escalates once and then
	// stops stacking keywords.
	again := SCFFix(osc.Keywords, TrendOscillating)
	if n := countTokens(again.Keywords, "SLOWCONV", "VERYSLOWCONV"); n != 1 {
		t.Errorf("restart-of-a-restart stacked %d SlowConv-family keywords: %v", n, again.Keywords)
	}
}

func TestAnalyzeSCFTrend(t *testing.T) {
	descending := []float64{-75.0, -75.2, -75.3, -75.35, -75.38, -75.40, -75.41, -75.42}
	if got := AnalyzeSCFTrend(descending); got != TrendDescending {
		t.Errorf("descending trace = %v", got)
	}
	oscillating := []float64{-75.0, -75.4, -75.1, -75.4, -75.1, -75.4, -75.1, -75.4}
	if got := AnalyzeSCFTrend(oscillating); got != TrendOscillating {
		t.Errorf("oscillating trace = %v", got)
	}
	if got := AnalyzeSCFTrend([]float64{-75.0, -75.1}); got != TrendUnknown {
		t.Errorf("short trace = %v, want unknown", got)
	}
	if got := AnalyzeSCFTrend(nil); got != TrendUnknown {
		t.Errorf("empty trace = %v, want unknown", got)
	}
}

// ---------------------------------------------------------------------------
// Memory fix
// ---------------------------------------------------------------------------

func TestMemoryFix(t *testing.T) {
	kws := []string{"r2SCAN-3c", "Opt"}

	// The diagnosis.ts worked example: 64 GB and 8 processes → 6000 MB.
	fix, ok := MemoryFix(kws, 4000, 8, 65536)
	if !ok || fix.MaxCoreMB != 6000 {
		t.Fatalf("MemoryFix(65536 MB, 8 procs) = %d MB (ok=%v), want 6000", fix.MaxCoreMB, ok)
	}
	if len(fix.Comments) == 0 || !strings.Contains(fix.Comments[0], "75%") {
		t.Errorf("memory fix must name the planning rule: %v", fix.Comments)
	}

	// No %pal → planned for a single process.
	fix, ok = MemoryFix(kws, 0, 0, 32768)
	if !ok || fix.MaxCoreMB != 24000 {
		t.Errorf("MemoryFix(32768 MB, no pal) = %d MB (ok=%v), want 24000", fix.MaxCoreMB, ok)
	}

	// RAM already caps the request: refuse instead of emitting an
	// impossible value.
	if _, ok := MemoryFix(kws, 4000, 1, 4096); ok {
		t.Error("MemoryFix should refuse when the formula cannot beat the current %maxcore")
	}
	if _, ok := MemoryFix(kws, 4000, 1, 0); ok {
		t.Error("MemoryFix should refuse when the machine RAM is unknown")
	}
	if MemoryCapNote(4000, 1, 4096) == "" || MemoryCapNote(4000, 1, 0) == "" {
		t.Error("MemoryCapNote must explain the refusal")
	}
}

// ---------------------------------------------------------------------------
// Stability fix
// ---------------------------------------------------------------------------

func TestStabilityFix(t *testing.T) {
	dft := inputparse.Parse("! B3LYP def2-SVP RKS Opt\n* xyz 0 1\nO 0.0 0.0 0.0\n*\n")
	fix := StabilityFix(dft.Keywords, dft)
	if !hasToken(fix.Keywords, "UKS") || hasToken(fix.Keywords, "RKS") {
		t.Errorf("DFT stability fix keywords = %v, want UKS and no RKS", fix.Keywords)
	}
	if !strings.Contains(strings.Join(fix.Blocks, "\n"), "StabPerform true") {
		t.Errorf("stability fix must request the stability analysis: %v", fix.Blocks)
	}

	hf := inputparse.Parse("! HF def2-SVP\n* xyz 0 1\nO 0.0 0.0 0.0\n*\n")
	if fix := StabilityFix(hf.Keywords, hf); !hasToken(fix.Keywords, "UHF") {
		t.Errorf("HF stability fix keywords = %v, want UHF", fix.Keywords)
	}

	// Idempotence.
	again := StabilityFix(fix.Keywords, dft)
	if n := countTokens(again.Keywords, "UKS", "UHF"); n != 1 {
		t.Errorf("stacked %d unrestricted tags: %v", n, again.Keywords)
	}
}

// ---------------------------------------------------------------------------
// MORead / transient
// ---------------------------------------------------------------------------

func TestWithMORead(t *testing.T) {
	fix := WithMORead(TransientFix([]string{"r2SCAN-3c", "Opt"}), "job.gbw")
	if !hasToken(fix.Keywords, "MOREAD") {
		t.Errorf("keywords = %v, want MORead", fix.Keywords)
	}
	if !strings.Contains(strings.Join(fix.Blocks, "\n"), `%moinp "job.gbw"`) {
		t.Errorf("blocks = %v, want %%moinp", fix.Blocks)
	}
	// A parent that already reads MOs must not gain a second keyword.
	fix = WithMORead(TransientFix([]string{"r2SCAN-3c", "MOREAD"}), "job.gbw")
	if n := countTokens(fix.Keywords, "MOREAD"); n != 1 {
		t.Errorf("MORead stacked %d times: %v", n, fix.Keywords)
	}
	// No .gbw → untouched.
	fix = WithMORead(TransientFix([]string{"r2SCAN-3c"}), "")
	if hasToken(fix.Keywords, "MOREAD") || len(fix.Blocks) != 0 {
		t.Errorf("empty gbw must be a no-op: %v %v", fix.Keywords, fix.Blocks)
	}
}

// ---------------------------------------------------------------------------
// Structure fallback
// ---------------------------------------------------------------------------

func TestStructureFromInput(t *testing.T) {
	inline := "! HF def2-SVP\n* xyz -1 2\nO 0.0 0.0 0.0\nH 0.0 0.0 0.97\n*\n"
	st, ok := StructureFromInput(inline)
	if !ok {
		t.Fatal("inline xyz block not recovered")
	}
	geom, isGeom := st.(inputbuild.Geometry)
	if !isGeom || len(geom) != 2 || geom[1].Z != 0.97 {
		t.Fatalf("recovered structure = %#v", st)
	}

	st, ok = StructureFromInput("! HF\n* xyzfile 0 1 start.xyz\n")
	if !ok {
		t.Fatal("xyzfile reference not recovered")
	}
	if f, isFile := st.(inputbuild.XYZFile); !isFile || string(f) != "start.xyz" {
		t.Fatalf("recovered structure = %#v", st)
	}

	if _, ok := StructureFromInput("! HF\n* gzmt 0 1\nO\n*\n"); ok {
		t.Error("gzmt blocks have no cartesian rows to carry — must refuse")
	}
	if _, ok := StructureFromInput("! HF def2-SVP\n"); ok {
		t.Error("input without coordinates must refuse")
	}
}

// ---------------------------------------------------------------------------
// Rendering: every fix renders to a lint-clean input with the change and
// the provenance visible.
// ---------------------------------------------------------------------------

func TestRenderFixIsLintClean(t *testing.T) {
	summary := inputparse.Parse("! r2SCAN-3c Opt\n%pal nprocs 4 end\n%maxcore 4000\n* xyz 0 1\nO 0.0 0.0 0.0\n*\n")
	geom := inputbuild.Geometry{{El: "O", X: 0, Y: 0, Z: 0}}
	prov := inputparse.Provenance{Edge: "restart", ParentExp: "exp", ParentRun: "run"}.Comment()

	mem, ok := MemoryFix(summary.Keywords, summary.MaxCoreMB, summary.NProcs, 65536)
	if !ok {
		t.Fatal("memory fix refused unexpectedly")
	}
	fixes := map[string]Fix{
		"scf-stage1": SCFFix(summary.Keywords, TrendUnknown),
		"scf-stage2": SCFFix(append(summary.Keywords, "SlowConv"), TrendOscillating),
		"memory":     WithMORead(mem, "job.gbw"),
		"stability":  StabilityFix(summary.Keywords, summary),
		"transient":  WithMORead(TransientFix(summary.Keywords), "job.gbw"),
	}
	for name, fix := range fixes {
		text := RenderFix(summary, fix, geom, prov)
		if !strings.HasPrefix(text, prov) {
			t.Errorf("%s: provenance comment missing:\n%s", name, text)
		}
		findings := inputlint.Lint(text, inputlint.Options{})
		if inputlint.HasErrors(findings) {
			t.Errorf("%s: generated input fails lint: %+v\n%s", name, findings, text)
		}
	}

	// The %maxcore override must actually land in the rendered text.
	if text := RenderFix(summary, mem, geom, prov); !strings.Contains(text, "%maxcore 12000\n") {
		t.Errorf("memory override missing (want %%maxcore 12000):\n%s", text)
	}
}

func TestDiff(t *testing.T) {
	oldText := "! HF def2-SVP\n* xyz 0 1\nO 0 0 0\n*\n"
	newText := "# fixed\n! HF def2-SVP SlowConv\n* xyz 0 1\nO 0 0 0\n*\n"
	d := Diff(oldText, newText)
	for _, want := range []string{"+ # fixed\n", "- ! HF def2-SVP\n", "+ ! HF def2-SVP SlowConv\n", "  *\n"} {
		if !strings.Contains(d, want) {
			t.Errorf("diff missing %q:\n%s", want, d)
		}
	}
}
