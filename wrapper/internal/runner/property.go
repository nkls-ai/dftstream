package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/nkls-ai/dftstream/internal/artifacts"
	"github.com/nkls-ai/dftstream/internal/fsutil"
	"github.com/nkls-ai/dftstream/internal/postproc"
	"github.com/nkls-ai/dftstream/internal/stringutil"
	"github.com/nkls-ai/dftstream/internal/telemetry"
	"github.com/nkls-ai/dftstream/internal/tracker"
)

// ORCA 6 can emit a machine-readable summary of everything it computed:
// `<base>.property.json` directly when the input carries JSONPropFile, or
// `<base>.property.txt` always, which `orca_2json <base> -property`
// converts. Those numbers come from ORCA's own data structures rather
// than from its printed report, which makes them the ground truth for
// anything we scraped out of stdout.
//
// This file ingests that JSON at run end and reconciles it against what
// the stdout parser produced. It deliberately does NOT overwrite the
// parsed values: a silent correction would hide a parser bug, which is
// the one thing a defensible number cannot afford. Disagreements are
// recorded as a data-quality event on the run.
//
// CLAUDE.md, non-negotiable: aux tools are never pointed at the user's
// files. orca_2json rewrites what it opens, so the .property.txt is
// COPIED into a scratch dir, converted there, and only the derived JSON
// travels back — in memory, as an artifact. Nothing in the chemist's
// directory is created, touched, or re-saved.

// propertyEnergyTolEh is how far ORCA's JSON and our stdout parse may
// differ before we call it a disagreement. The printed thermochemistry
// carries six decimals, so a pure formatting round-trip is bounded by
// 5e-7 Eh; 1e-6 Eh leaves room for that and nothing else. (For scale:
// chemical accuracy is ~1.6e-3 Eh, so anything this flags is a bug in
// our parsing, not a chemistry question.)
const propertyEnergyTolEh = 1e-6

// propertyConvertTimeout bounds the orca_2json call. The conversion is
// pure text munging on a file measured in kilobytes; anything slower is
// a hung tool, not a slow one.
const propertyConvertTimeout = 30 * time.Second

// propertyValues are the scalars we can cross-check against the stdout
// parse. Every field is optional — which sections ORCA writes depends
// entirely on the job type.
type propertyValues struct {
	FinalEnergyEh *float64
	ZPEEh         *float64
	EnthalpyEh    *float64
	GibbsEh       *float64
}

// empty reports whether nothing usable was found in the JSON.
func (p propertyValues) empty() bool {
	return p.FinalEnergyEh == nil && p.ZPEEh == nil && p.EnthalpyEh == nil && p.GibbsEh == nil
}

// discrepancy is one field where ORCA's JSON and our stdout parse
// disagree beyond the tolerance.
type discrepancy struct {
	Field    string  `json:"field"`
	Parsed   float64 `json:"parsedFromStdout"`
	Property float64 `json:"fromPropertyJson"`
	DeltaEh  float64 `json:"deltaEh"`
}

// derivedArtifacts returns artifacts DFTStream produced itself that were
// never written to the chemist's directory — currently just the
// .property.json converted in scratch. Safe to call when nothing was
// derived.
func (s *runSession) derivedArtifacts() []artifacts.Artifact {
	if len(s.propertyJSON) == 0 {
		return nil
	}
	a := artifacts.Artifact{
		Name:      s.stem + ".property.json",
		Path:      "", // derived in a scratch dir that no longer exists
		Kind:      artifacts.KindProperty,
		SizeBytes: int64(len(s.propertyJSON)),
		MTime:     time.Now(),
	}
	artifacts.AttachContent(&a, s.propertyJSON)
	return []artifacts.Artifact{a}
}

// ingestProperties loads ORCA's property JSON (converting the
// .property.txt in a scratch dir when needed) and reconciles it against
// upd, the status update the stdout parser produced. Entirely
// best-effort: no property file, no aux tool, or a shape we do not
// recognize are all normal outcomes that leave the run untouched.
func (s *runSession) ingestProperties(ctx context.Context, upd tracker.StatusUpdate) {
	raw, derived, err := s.loadPropertyJSON(ctx)
	if err != nil {
		s.log.Debug("property file not ingested", map[string]any{"error": err.Error()})
		return
	}
	if len(raw) == 0 {
		return
	}
	if derived {
		// Keep it for the artifact manifest; it exists nowhere on disk.
		s.propertyJSON = raw
	}

	pv, err := extractPropertyValues(raw)
	if err != nil {
		s.log.Warn("property JSON could not be read", map[string]any{"error": err.Error()})
		return
	}
	if pv.empty() {
		s.log.Debug("property JSON carried no comparable values", nil)
		return
	}

	checked, mismatches := reconcileProperties(pv, upd)
	payload := map[string]any{
		"check":         "property_json",
		"source":        map[bool]string{true: "orca_2json", false: "orca"}[derived],
		"fieldsChecked": checked,
		"toleranceEh":   propertyEnergyTolEh,
		"ok":            len(mismatches) == 0,
	}
	if len(mismatches) > 0 {
		payload["mismatches"] = mismatches
		for _, m := range mismatches {
			s.log.Warn("stdout parse disagrees with ORCA's property file", map[string]any{
				"field": m.Field, "parsedFromStdout": m.Parsed,
				"fromPropertyJson": m.Property, "deltaEh": m.DeltaEh,
			})
		}
		fmt.Fprintf(s.opts.Stderr, "[dftstream] data quality: %d value(s) disagree with %s.property.json — see the run's events\n",
			len(mismatches), s.stem)
	} else {
		s.log.Info("property file reconciled with stdout parse", map[string]any{"fieldsChecked": checked})
	}

	// Seq -1 marks an out-of-band event: it is not part of the parser's
	// sequenced stream, it is produced after ORCA exited.
	if err := s.opts.Tracker.AppendEvent(ctx, s.runID, tracker.Event{
		Seq: -1, TS: time.Now(), Kind: "data_quality", Payload: payload,
	}); err != nil {
		s.errs.add(fmt.Errorf("record property reconciliation: %w", err))
	}
}

// loadPropertyJSON returns the run's property JSON. It prefers the file
// ORCA wrote itself (JSONPropFile); failing that it converts the
// .property.txt with orca_2json inside a scratch dir. The bool reports
// whether the JSON was derived by us (and therefore exists only in
// memory).
func (s *runSession) loadPropertyJSON(ctx context.Context) ([]byte, bool, error) {
	native := filepath.Join(s.workDir, s.stem+".property.json")
	// A read failure here is not an error to report: ORCA only writes this
	// file when the input asked for JSONPropFile, so "not there" is the
	// common case and the .property.txt conversion below is the fallback.
	// If that fails too, its error is what the caller sees.
	if raw, err := os.ReadFile(native); err == nil {
		return raw, false, nil
	}
	txt := filepath.Join(s.workDir, s.stem+".property.txt")
	if _, err := os.Stat(txt); err != nil {
		return nil, false, fmt.Errorf("no property file for %s", s.stem)
	}
	raw, err := convertPropertyTxt(ctx, filepath.Dir(s.opts.OrcaPath), txt, s.stem)
	if err != nil {
		return nil, false, err
	}
	return raw, true, nil
}

// convertPropertyTxt runs `orca_2json <stem> -property` against a COPY of
// txtPath in a throwaway scratch dir and returns the resulting JSON.
//
// The copy is the whole point: orca_2json rewrites the files it opens, and
// a run's .property.txt must come out of a dftstream run byte-for-byte
// identical to a plain `orca` run. The original is only ever read.
func convertPropertyTxt(ctx context.Context, orcaDir, txtPath, stem string) ([]byte, error) {
	bin := filepath.Join(orcaDir, "orca_2json")
	if _, err := os.Stat(bin); err != nil {
		return nil, fmt.Errorf("orca_2json not available next to orca: %w", err)
	}
	scratch, err := os.MkdirTemp("", "dftstream-2json-")
	if err != nil {
		return nil, fmt.Errorf("property scratch: %w", err)
	}
	defer func() {
		if err := os.RemoveAll(scratch); err != nil {
			// Leftover scratch in the system temp dir is harmless and the
			// conversion result is already in hand; say so and move on.
			fmt.Fprintf(os.Stderr, "  warning: could not remove property scratch %s: %v\n", scratch, err) //nolint:errcheck — write to stderr is best-effort
		}
	}()

	staged := filepath.Join(scratch, stem+".property.txt")
	if err := fsutil.CopyFile(txtPath, staged); err != nil {
		return nil, fmt.Errorf("stage property.txt for orca_2json: %w", err)
	}

	cctx, cancel := context.WithTimeout(ctx, propertyConvertTimeout)
	defer cancel()
	out, err := propertyRunner.Run(cctx, scratch, bin, []string{stem, "-property"}, "")
	if err != nil {
		return nil, fmt.Errorf("orca_2json: %w (output: %s)", err, out)
	}
	raw, err := os.ReadFile(filepath.Join(scratch, stem+".property.json"))
	if err != nil {
		return nil, fmt.Errorf("orca_2json produced no JSON: %w", err)
	}
	return raw, nil
}

// propertyRunner spawns orca_2json. A package-level variable so tests can
// substitute a fake instead of requiring a real ORCA install. It reuses
// postproc.CommandRunner as the contract so aux-tool invocation has one
// shape across the wrapper.
var propertyRunner postproc.CommandRunner = execPropertyRunner{}

// execPropertyRunner is the production runner: spawn the tool in dir,
// capture everything it says.
type execPropertyRunner struct{}

func (execPropertyRunner) Run(ctx context.Context, dir, bin string, args []string, stdin string) (string, error) {
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = dir
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	err := cmd.Run()
	return stringutil.Tail(buf.String(), 400), err
}

// propertyKeyAliases maps the normalized key names ORCA uses inside the
// property JSON onto the fields we cross-check. Normalization strips
// underscores and case, so "SCF_ENERGY", "scf_energy" and "SCFEnergy"
// all collapse to the same alias.
//
// Multiple aliases per field are ranked: a later entry in the list only
// fills a field the earlier ones did not. ORCA writes several flavours of
// "the energy" (SCF, dispersion-corrected, post-HF) and the one that
// corresponds to stdout's FINAL SINGLE POINT ENERGY is whichever total
// the last geometry block reports.
var propertyKeyAliases = map[string][]string{
	"finalEnergyEh": {"FINALENERGY", "TOTALENERGY", "FINALEN", "SCFENERGY"},
	"zpeEh":         {"ZPE", "ZPECORRECTION"},
	"enthalpyEh":    {"ENTHALPYH", "TOTALENTHALPY"},
	"gibbsEh":       {"FREEENERGYG", "TOTALFREEENERGY", "GIBBSFREEENERGY"},
}

// normalizePropertyKey collapses ORCA's key spellings to a single form.
func normalizePropertyKey(k string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(k) {
		if (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// extractPropertyValues walks the property JSON and picks out the scalars
// we can compare. ORCA nests them differently per job type and version
// (Geometry_1/SCF_Energy/SCF_ENERGY, Geometry_2/Thermochemistry_Energies/
// FREEENERGYG, ...), so rather than encode a schema that breaks on the
// next ORCA release we walk the whole tree and match on key name.
//
// Later occurrences win: the blocks appear in calculation order, so the
// last Geometry_N holds the values stdout's final summary describes.
func extractPropertyValues(raw []byte) (propertyValues, error) {
	var root any
	if err := json.Unmarshal(raw, &root); err != nil {
		return propertyValues{}, fmt.Errorf("parse property JSON: %w", err)
	}
	found := map[string]float64{} // normalized key -> last numeric value
	collectNumericLeaves(root, found)

	var pv propertyValues
	pick := func(field string) *float64 {
		for _, alias := range propertyKeyAliases[field] {
			if v, ok := found[alias]; ok {
				val := v
				return &val
			}
		}
		return nil
	}
	pv.FinalEnergyEh = pick("finalEnergyEh")
	pv.ZPEEh = pick("zpeEh")
	pv.EnthalpyEh = pick("enthalpyEh")
	pv.GibbsEh = pick("gibbsEh")
	return pv, nil
}

// collectNumericLeaves records every numeric leaf by normalized key name,
// keeping the LAST value seen for a repeated key. Arrays are traversed so
// nothing is missed, but they contribute no keys of their own.
//
// Object keys are visited in natural order, NOT Go's randomized map order:
// "last wins" is only meaningful if the walk is deterministic, and the whole
// point of the rule is that the highest Geometry_N is the final geometry.
// Natural (not lexicographic) order is what makes Geometry_10 sort after
// Geometry_2 instead of before it.
func collectNumericLeaves(node any, out map[string]float64) {
	switch n := node.(type) {
	case map[string]any:
		for _, k := range naturalOrderKeys(n) {
			v := n[k]
			switch val := v.(type) {
			case float64:
				if !math.IsNaN(val) && !math.IsInf(val, 0) {
					out[normalizePropertyKey(k)] = val
				}
			default:
				collectNumericLeaves(v, out)
			}
		}
	case []any:
		for _, v := range n {
			collectNumericLeaves(v, out)
		}
	}
}

// naturalOrderKeys sorts object keys so a trailing number compares
// numerically: Geometry_2 before Geometry_10. Keys without a trailing number
// compare as plain strings.
func naturalOrderKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		pi, ni := splitTrailingNumber(keys[i])
		pj, nj := splitTrailingNumber(keys[j])
		if pi != pj {
			return pi < pj
		}
		return ni < nj
	})
	return keys
}

// splitTrailingNumber returns the key's non-numeric prefix and its trailing
// integer (-1 when there is none, so an unnumbered key sorts before its
// numbered siblings).
func splitTrailingNumber(k string) (string, int) {
	i := len(k)
	for i > 0 && k[i-1] >= '0' && k[i-1] <= '9' {
		i--
	}
	if i == len(k) {
		return k, -1
	}
	n, err := strconv.Atoi(k[i:])
	if err != nil {
		// Only reachable for a digit run too long for an int; treat the key as
		// unnumbered rather than dropping it from the walk.
		return k, -1
	}
	return k[:i], n
}

// reconcileProperties compares ORCA's own numbers with the stdout parse,
// returning how many fields could be compared and the ones that
// disagreed. A field present on only one side is not a disagreement —
// stdout and the property file cover overlapping, not identical, ground.
func reconcileProperties(pv propertyValues, upd tracker.StatusUpdate) (int, []discrepancy) {
	pairs := []struct {
		field    string
		parsed   *float64
		property *float64
	}{
		{"lastEnergy", upd.LastEnergy, pv.FinalEnergyEh},
		{"zpeEh", upd.ZPEEh, pv.ZPEEh},
		{"enthalpyEh", upd.EnthalpyEh, pv.EnthalpyEh},
		{"gibbsEh", upd.GibbsEh, pv.GibbsEh},
	}
	checked := 0
	var out []discrepancy
	for _, p := range pairs {
		if p.parsed == nil || p.property == nil {
			continue
		}
		checked++
		delta := *p.parsed - *p.property
		if math.Abs(delta) > propertyEnergyTolEh {
			out = append(out, discrepancy{
				Field: p.field, Parsed: *p.parsed, Property: *p.property, DeltaEh: delta,
			})
		}
	}
	return checked, out
}

// reportTelemetry sends the run's outcome to an operator-configured
// endpoint. Disabled unless someone explicitly opted in (see
// internal/telemetry), and even then it carries only the job's run types,
// ORCA's version and the parser's error class — never a molecule, never a
// filename. Failures are logged at debug and go no further: a telemetry
// problem is not the chemist's problem.
func (s *runSession) reportTelemetry(ctx context.Context, upd tracker.StatusUpdate, status tracker.RunStatus) {
	cfg := telemetry.FromEnv()
	if !cfg.Enabled() {
		return
	}
	rep := telemetry.Report{
		RunTypes: runTypeStrings(s.summary.RunTypes),
		OK:       status == tracker.StatusFinished,
	}
	if upd.OrcaVersion != nil {
		rep.OrcaVersion = *upd.OrcaVersion
	}
	if upd.ErrorClass != nil {
		rep.ErrorClass = *upd.ErrorClass
	}
	if err := cfg.Send(ctx, rep); err != nil {
		s.log.Debug("telemetry delivery failed", map[string]any{"error": err.Error()})
	}
}
