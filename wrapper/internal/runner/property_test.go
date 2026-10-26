package runner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nkls-ai/dftstream/internal/logging"
	"github.com/nkls-ai/dftstream/internal/tracker"
)

// A trimmed but structurally faithful ORCA 6 property.json: nested
// Geometry_N blocks, screaming-snake keys, and the thermochemistry block
// carrying totals rather than corrections.
const samplePropertyJSON = `{
  "ORCA Header": {"VERSION": "6.0.1"},
  "Geometry_1": {
    "Calculation_Info": {"MULT": 1, "CHARGE": 0, "NUMOFATOMS": 3},
    "SCF_Energy": {"SCF_ENERGY": -76.026760000000},
    "Mulliken_Population_Analysis": {"ATOMICCHARGES": [-0.5, 0.25, 0.25]}
  },
  "Geometry_2": {
    "Calculation_Info": {"MULT": 1, "CHARGE": 0, "NUMOFATOMS": 3},
    "SCF_Energy": {"SCF_ENERGY": -76.400000000000},
    "Thermochemistry_Energies": {
      "TEMPERATURE": 298.15,
      "ZPE": 0.008608,
      "INNERENERGYU": -75.960000,
      "ENTHALPYH": -75.959070,
      "ENTROPYS": 0.021416,
      "FREEENERGYG": -75.980486
    }
  }
}`

func TestExtractPropertyValuesTakesTheLastGeometryBlock(t *testing.T) {
	pv, err := extractPropertyValues([]byte(samplePropertyJSON))
	if err != nil {
		t.Fatalf("extractPropertyValues: %v", err)
	}
	if pv.empty() {
		t.Fatal("nothing extracted from a well-formed property JSON")
	}
	if pv.FinalEnergyEh == nil || *pv.FinalEnergyEh != -76.4 {
		t.Errorf("final energy = %v, want -76.4 (the last geometry's SCF energy)", pv.FinalEnergyEh)
	}
	if pv.ZPEEh == nil || *pv.ZPEEh != 0.008608 {
		t.Errorf("ZPE = %v, want 0.008608", pv.ZPEEh)
	}
	if pv.EnthalpyEh == nil || *pv.EnthalpyEh != -75.959070 {
		t.Errorf("enthalpy = %v, want -75.959070", pv.EnthalpyEh)
	}
	if pv.GibbsEh == nil || *pv.GibbsEh != -75.980486 {
		t.Errorf("Gibbs = %v, want -75.980486", pv.GibbsEh)
	}
}

// The "last Geometry_N wins" rule is only meaningful if the walk is
// deterministic. Go randomizes map iteration, so this ran differently on every
// invocation until the walk was ordered — and picked an intermediate
// geometry's energy roughly a third of the time. Geometry_10 also has to sort
// after Geometry_2, which plain lexicographic order gets wrong.
func TestExtractPropertyValuesPicksTheHighestGeometryDeterministically(t *testing.T) {
	var b strings.Builder
	b.WriteString(`{"Geometry_1":{"SCF_Energy":{"SCF_ENERGY":-1.0}}`)
	for i := 2; i <= 12; i++ {
		fmt.Fprintf(&b, `,"Geometry_%d":{"SCF_Energy":{"SCF_ENERGY":-%d.0}}`, i, i)
	}
	b.WriteString("}")
	raw := []byte(b.String())

	// Repeat: a single pass can pass by luck under a randomized walk.
	for i := 0; i < 50; i++ {
		pv, err := extractPropertyValues(raw)
		if err != nil {
			t.Fatalf("extractPropertyValues: %v", err)
		}
		if pv.FinalEnergyEh == nil || *pv.FinalEnergyEh != -12.0 {
			t.Fatalf("pass %d: final energy = %v, want -12 (Geometry_12, the last one)", i, pv.FinalEnergyEh)
		}
	}
}

func TestNaturalOrderKeysSortsNumericSuffixes(t *testing.T) {
	keys := naturalOrderKeys(map[string]any{
		"Geometry_10": nil, "Geometry_2": nil, "Geometry_1": nil, "Calculation_Info": nil,
	})
	want := []string{"Calculation_Info", "Geometry_1", "Geometry_2", "Geometry_10"}
	if len(keys) != len(want) {
		t.Fatalf("keys = %v, want %v", keys, want)
	}
	for i := range want {
		if keys[i] != want[i] {
			t.Fatalf("keys = %v, want %v", keys, want)
		}
	}
}

func TestExtractPropertyValuesToleratesUnknownShapes(t *testing.T) {
	for name, raw := range map[string]string{
		"empty object": `{}`,
		"array root":   `[{"SCF_ENERGY": 1.0}]`,
		"deep nesting": `{"a":{"b":{"c":{"FINALENERGY": -1.5}}}}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := extractPropertyValues([]byte(raw)); err != nil {
				t.Fatalf("extractPropertyValues(%s): %v", name, err)
			}
		})
	}
	if _, err := extractPropertyValues([]byte("not json")); err == nil {
		t.Error("extractPropertyValues accepted non-JSON")
	}
}

func TestReconcilePropertiesFlagsOnlyRealDisagreements(t *testing.T) {
	pv, err := extractPropertyValues([]byte(samplePropertyJSON))
	if err != nil {
		t.Fatal(err)
	}

	// Stdout parse that agrees to the printed precision: no findings.
	agreeing := tracker.StatusUpdate{
		LastEnergy: f64(-76.4),
		ZPEEh:      f64(0.008608),
		EnthalpyEh: f64(-75.959070),
		GibbsEh:    f64(-75.980486),
	}
	checked, bad := reconcileProperties(pv, agreeing)
	if checked != 4 {
		t.Errorf("checked %d fields, want 4", checked)
	}
	if len(bad) != 0 {
		t.Errorf("agreeing values reported as mismatches: %+v", bad)
	}

	// A rounding-level difference is not a disagreement.
	nearly := agreeing
	nearly.GibbsEh = f64(-75.9804865)
	if _, bad := reconcileProperties(pv, nearly); len(bad) != 0 {
		t.Errorf("half-ULP difference flagged: %+v", bad)
	}

	// A real one is.
	wrong := agreeing
	wrong.LastEnergy = f64(-76.399)
	_, bad = reconcileProperties(pv, wrong)
	if len(bad) != 1 || bad[0].Field != "lastEnergy" {
		t.Fatalf("expected one lastEnergy mismatch, got %+v", bad)
	}
	if bad[0].Property != -76.4 || bad[0].Parsed != -76.399 {
		t.Errorf("mismatch does not carry both sides: %+v", bad[0])
	}

	// Fields present on only one side are simply not comparable.
	partial := tracker.StatusUpdate{LastEnergy: f64(-76.4)}
	if checked, bad := reconcileProperties(pv, partial); checked != 1 || len(bad) != 0 {
		t.Errorf("partial parse: checked=%d bad=%+v, want 1 and none", checked, bad)
	}
}

// fakePropertyRunner stands in for orca_2json: it records where it ran and
// writes the JSON the real tool would.
type fakePropertyRunner struct {
	dir   string
	bin   string
	args  []string
	fail  error
	wrote bool
}

func (f *fakePropertyRunner) Run(_ context.Context, dir, bin string, args []string, _ string) (string, error) {
	f.dir, f.bin, f.args = dir, bin, args
	if f.fail != nil {
		return "simulated failure", f.fail
	}
	// The real tool consumes <stem>.property.txt from its cwd and writes
	// <stem>.property.json beside it — and re-saves what it opened, which is
	// precisely why it must never see the chemist's copy.
	stem := args[0]
	if err := os.WriteFile(filepath.Join(dir, stem+".property.txt"), []byte("REWRITTEN BY THE TOOL\n"), 0o644); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(dir, stem+".property.json"), []byte(samplePropertyJSON), 0o644); err != nil {
		return "", err
	}
	f.wrote = true
	return "", nil
}

// CLAUDE.md, non-negotiable: an aux tool never runs against the user's
// files. orca_2json rewrites what it opens, so the original .property.txt
// must be byte-identical after the conversion.
func TestConvertPropertyTxtNeverTouchesTheOriginal(t *testing.T) {
	workDir := t.TempDir()
	orcaDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(orcaDir, "orca_2json"), []byte("stub"), 0o755); err != nil {
		t.Fatal(err)
	}
	original := []byte("$ SCF_Energy\n   description: The SCF energy\n   value: -76.4\n")
	txt := filepath.Join(workDir, "h2o.property.txt")
	if err := os.WriteFile(txt, original, 0o644); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(txt)
	if err != nil {
		t.Fatal(err)
	}

	fake := &fakePropertyRunner{}
	restore := swapPropertyRunner(fake)
	defer restore()

	raw, err := convertPropertyTxt(context.Background(), orcaDir, txt, "h2o")
	if err != nil {
		t.Fatalf("convertPropertyTxt: %v", err)
	}
	if !json.Valid(raw) {
		t.Fatalf("converted output is not JSON: %q", raw)
	}
	if !fake.wrote {
		t.Fatal("fake tool was never invoked")
	}

	// The tool ran somewhere else entirely.
	if fake.dir == workDir {
		t.Error("orca_2json ran in the chemist's directory — it must run in a scratch copy")
	}
	if len(fake.args) != 2 || fake.args[0] != "h2o" || fake.args[1] != "-property" {
		t.Errorf("args = %v, want [h2o -property]", fake.args)
	}

	// And the original is untouched, byte for byte.
	after, err := os.ReadFile(txt)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(original) {
		t.Fatalf("original .property.txt was modified:\n got: %q\nwant: %q", after, original)
	}
	afterStat, err := os.Stat(txt)
	if err != nil {
		t.Fatal(err)
	}
	if !afterStat.ModTime().Equal(before.ModTime()) {
		t.Error("original .property.txt mtime changed — the tool must not open it at all")
	}

	// The scratch dir is cleaned up; nothing of ours is left behind.
	if _, err := os.Stat(fake.dir); !os.IsNotExist(err) {
		t.Errorf("scratch dir %s survived the conversion (stat err = %v)", fake.dir, err)
	}
	// Nor did anything new appear next to the chemist's files.
	entries, err := os.ReadDir(workDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		names := make([]string, len(entries))
		for i, e := range entries {
			names[i] = e.Name()
		}
		t.Errorf("conversion wrote into the working directory: %v", names)
	}
}

func TestConvertPropertyTxtSkipsWhenToolIsAbsent(t *testing.T) {
	workDir := t.TempDir()
	txt := filepath.Join(workDir, "h2o.property.txt")
	if err := os.WriteFile(txt, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := convertPropertyTxt(context.Background(), t.TempDir(), txt, "h2o"); err == nil {
		t.Fatal("convertPropertyTxt succeeded without orca_2json present")
	}
}

// swapPropertyRunner installs a fake aux-tool runner and returns a restore
// func. Tests must never spawn a real ORCA binary.
func swapPropertyRunner(r *fakePropertyRunner) func() {
	prev := propertyRunner
	propertyRunner = r
	return func() { propertyRunner = prev }
}

// loadPropertyJSON prefers the file ORCA wrote itself; only when there is
// no .property.json does it reach for the converter.
func TestLoadPropertyJSONPrefersNativeFile(t *testing.T) {
	workDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(workDir, "h2o.property.json"), []byte(samplePropertyJSON), 0o644); err != nil {
		t.Fatal(err)
	}
	fake := &fakePropertyRunner{}
	restore := swapPropertyRunner(fake)
	defer restore()

	s := &runSession{workDir: workDir, stem: "h2o", opts: Options{OrcaPath: filepath.Join(t.TempDir(), "orca")}}
	raw, derived, err := s.loadPropertyJSON(context.Background())
	if err != nil {
		t.Fatalf("loadPropertyJSON: %v", err)
	}
	if derived {
		t.Error("native .property.json reported as derived")
	}
	if len(raw) == 0 {
		t.Error("native .property.json came back empty")
	}
	if fake.wrote {
		t.Error("orca_2json was run even though ORCA had already written the JSON")
	}
}

func TestLoadPropertyJSONIsQuietWhenThereIsNoPropertyFile(t *testing.T) {
	s := &runSession{workDir: t.TempDir(), stem: "h2o", opts: Options{OrcaPath: "/nonexistent/orca"}}
	if _, _, err := s.loadPropertyJSON(context.Background()); err == nil {
		t.Fatal("loadPropertyJSON reported success with no property file present")
	}
}

// The derived JSON is uploaded as an artifact rather than written next to
// the chemist's files.
func TestDerivedArtifactsCarriesThePropertyJSON(t *testing.T) {
	s := &runSession{stem: "h2o"}
	if got := s.derivedArtifacts(); got != nil {
		t.Fatalf("derivedArtifacts with nothing derived = %v, want nil", got)
	}
	s.propertyJSON = []byte(samplePropertyJSON)
	got := s.derivedArtifacts()
	if len(got) != 1 {
		t.Fatalf("derivedArtifacts = %d items, want 1", len(got))
	}
	if got[0].Name != "h2o.property.json" {
		t.Errorf("name = %q, want h2o.property.json", got[0].Name)
	}
	if got[0].Path != "" {
		t.Errorf("path = %q, want empty — the file exists nowhere on disk", got[0].Path)
	}
	if got[0].ContentText == "" {
		t.Error("derived artifact carries no content")
	}
	if got[0].MTime.After(time.Now().Add(time.Minute)) {
		t.Error("derived artifact mtime is in the future")
	}
}

// End to end at the session level: a disagreement between ORCA's own
// numbers and our stdout parse must land on the run as a data-quality
// event, not just in a log line nobody reads.
func TestIngestPropertiesEmitsDataQualityEvent(t *testing.T) {
	workDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(workDir, "h2o.property.json"), []byte(samplePropertyJSON), 0o644); err != nil {
		t.Fatal(err)
	}
	rec := &recordingTracker{}
	s := &runSession{
		workDir: workDir,
		stem:    "h2o",
		runID:   "run-id",
		log:     logging.New(logging.LevelOff),
		opts:    Options{Tracker: rec, Stderr: io.Discard, OrcaPath: filepath.Join(t.TempDir(), "orca")},
	}

	// Stdout says -76.399; ORCA's property file says -76.4.
	s.ingestProperties(context.Background(), tracker.StatusUpdate{LastEnergy: f64(-76.399)})

	var found *tracker.Event
	for i := range rec.events {
		if rec.events[i].Kind == "data_quality" {
			found = &rec.events[i]
		}
	}
	if found == nil {
		t.Fatalf("no data_quality event recorded; got %d events", len(rec.events))
	}
	if ok, _ := found.Payload["ok"].(bool); ok {
		t.Error("event reports ok=true despite a disagreement")
	}
	mismatches, _ := found.Payload["mismatches"].([]discrepancy)
	if len(mismatches) != 1 || mismatches[0].Field != "lastEnergy" {
		t.Errorf("payload mismatches = %+v, want one lastEnergy entry", found.Payload["mismatches"])
	}
	if found.Seq != -1 {
		t.Errorf("seq = %d, want -1 (out of band, after ORCA exited)", found.Seq)
	}
	// A native property.json is already on disk; nothing extra to upload.
	if s.derivedArtifacts() != nil {
		t.Error("a natively written property.json must not be re-uploaded as a derived artifact")
	}
}

// An agreeing run still records the check — that is what makes the number
// defensible later.
func TestIngestPropertiesRecordsAgreement(t *testing.T) {
	workDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(workDir, "h2o.property.json"), []byte(samplePropertyJSON), 0o644); err != nil {
		t.Fatal(err)
	}
	rec := &recordingTracker{}
	s := &runSession{
		workDir: workDir, stem: "h2o", runID: "run-id",
		log:  logging.New(logging.LevelOff),
		opts: Options{Tracker: rec, Stderr: io.Discard, OrcaPath: filepath.Join(t.TempDir(), "orca")},
	}
	s.ingestProperties(context.Background(), tracker.StatusUpdate{
		LastEnergy: f64(-76.4), GibbsEh: f64(-75.980486),
	})
	if len(rec.events) != 1 {
		t.Fatalf("events = %d, want exactly 1", len(rec.events))
	}
	if ok, _ := rec.events[0].Payload["ok"].(bool); !ok {
		t.Errorf("agreeing run reported ok=%v", rec.events[0].Payload["ok"])
	}
	if got := rec.events[0].Payload["fieldsChecked"]; got != 2 {
		t.Errorf("fieldsChecked = %v, want 2", got)
	}
}

// A failing or absent aux tool is normal, not an error: the run is already
// finished and its data is already recorded.
func TestIngestPropertiesSurvivesToolFailure(t *testing.T) {
	workDir := t.TempDir()
	orcaDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(orcaDir, "orca_2json"), []byte("stub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workDir, "h2o.property.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	restore := swapPropertyRunner(&fakePropertyRunner{fail: errors.New("orca_2json: segmentation fault")})
	defer restore()

	rec := &recordingTracker{}
	s := &runSession{
		workDir: workDir, stem: "h2o", runID: "run-id",
		log:  logging.New(logging.LevelOff),
		opts: Options{Tracker: rec, Stderr: io.Discard, OrcaPath: filepath.Join(orcaDir, "orca")},
	}
	s.ingestProperties(context.Background(), tracker.StatusUpdate{LastEnergy: f64(-76.4)})

	if len(rec.events) != 0 {
		t.Errorf("a failed conversion recorded %d events, want none", len(rec.events))
	}
	if s.errs.err() != nil {
		t.Errorf("a failed conversion failed the run: %v", s.errs.err())
	}
}
