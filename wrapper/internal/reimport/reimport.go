// Package reimport recomputes the parser-derived fields of already-tracked
// runs with the CURRENT parser and describes the drift against what the
// backend stores (P0-5 backfill tooling: `dftstream reimport`).
//
// The package is strictly read-only with respect to ORCA's files: outputs are
// consumed as text, and nothing here ever writes to or stages a chemist's
// files. The only writes are backend patches, built by Patch and applied by
// the caller through the reimport:apply mutation.
package reimport

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/nkls-ai/dftstream/internal/inputparse"
	"github.com/nkls-ai/dftstream/internal/runner"
	"github.com/nkls-ai/dftstream/internal/tracker"
)

// FieldPolicy says how a drifted field may be written back.
type FieldPolicy int

const (
	// PolicyVerdict fields are owned by the parser outright: the recomputed
	// value replaces the stored one, and a recomputed ABSENCE clears it (the
	// phase-aware parser deciding stored thermo belonged to a pre-convergence
	// hessian is a correction, not missing data).
	PolicyVerdict FieldPolicy = iota
	// PolicyMeasurement fields are captured observations (last streamed
	// energy, ORCA's own wallclock line). A re-parse may refine them but never
	// erase them: absence after recompute means "could not reproduce", not
	// "was never true".
	PolicyMeasurement
)

// Fields is the parser-derived slice of a runs row — exactly the set the
// backend's reimport:apply whitelist accepts, as pointers so absent and
// present-but-zero stay distinct. The JSON tags match both the reimport:
// listRuns projection (decoding stored rows) and the mutation's arg names.
// Numeric fields are float64 across the board because Convex has a single
// number type: a stored count arrives as "0.0" and must decode.
type Fields struct {
	LastEnergy     *float64 `json:"lastEnergy,omitempty"`
	WallclockSec   *float64 `json:"wallclockSec,omitempty"`
	Converged      *bool    `json:"converged,omitempty"`
	OptMaxCycles   *bool    `json:"optMaxCycles,omitempty"`
	ImaginaryModes *float64 `json:"imaginaryModes,omitempty"`
	ZPEEh          *float64 `json:"zpeEh,omitempty"`
	EnthalpyEh     *float64 `json:"enthalpyEh,omitempty"`
	EntropyCorrEh  *float64 `json:"entropyCorrEh,omitempty"`
	GibbsEh        *float64 `json:"gibbsEh,omitempty"`
	GMinusEEh      *float64 `json:"gMinusEEh,omitempty"`
	S2             *float64 `json:"s2,omitempty"`
	S2Ideal        *float64 `json:"s2Ideal,omitempty"`
	ErrorClass     *string  `json:"errorClass,omitempty"`
	ErrorExcerpt   *string  `json:"errorExcerpt,omitempty"`
}

// Run is one row of the reimport:listRuns page: identity, the execution facts
// the recompute is parameterized on, and the stored parser-derived values.
type Run struct {
	ID             string   `json:"_id"`
	Name           string   `json:"name"`
	Status         string   `json:"status"`
	ExitCode       *float64 `json:"exitCode"` // Convex number; integral in practice
	StartedAt      float64  `json:"startedAt"`
	InputText      string   `json:"inputText"`
	InputPath      string   `json:"inputPath"`
	Cwd            string   `json:"cwd"`
	ReimportedAt   *float64 `json:"reimportedAt"`
	ReimportedWith *string  `json:"reimportedWith"`
	Fields
}

// UnmarshalRow decodes one reimport:listRuns page row.
func (r *Run) UnmarshalRow(raw json.RawMessage) error {
	if err := json.Unmarshal(raw, r); err != nil {
		return fmt.Errorf("decode reimport run row: %w", err)
	}
	if r.ID == "" {
		return fmt.Errorf("reimport run row has no _id")
	}
	return nil
}

// Terminal reports whether the run has a final verdict to recompute. Pending
// and running rows are the live wrapper's to write, never reimport's.
func (r Run) Terminal() bool {
	return r.Status == string(tracker.StatusFinished) || r.Status == string(tracker.StatusFailed)
}

// EffectiveExitCode is the exit code the recompute is parameterized on: the
// stored one when present, otherwise the convention the offline ingest path
// uses (finished→0, failed→1).
func (r Run) EffectiveExitCode() int {
	if r.ExitCode != nil {
		return int(*r.ExitCode)
	}
	if r.Status == string(tracker.StatusFinished) {
		return 0
	}
	return 1
}

// Recompute re-derives the parser-owned fields for one run by replaying its
// output text through the current parser, using the run's stored input for
// run-type semantics (opt vs NEB band vs plain) and its stored execution
// facts. The derivation is runner.RecomputeStatus — the same accumulator the
// live pipeline uses — so identical output yields an identical verdict.
func Recompute(ctx context.Context, run Run, output io.Reader) (Fields, error) {
	summary := inputparse.Parse(run.InputText)
	upd, err := runner.RecomputeStatus(ctx, summary, output,
		tracker.RunStatus(run.Status), run.EffectiveExitCode())
	if err != nil {
		return Fields{}, fmt.Errorf("re-parse output: %w", err)
	}
	return fromStatusUpdate(upd), nil
}

// fromStatusUpdate copies the reimport-owned subset of a terminal
// StatusUpdate. Status/ExitCode/FinishedAt/OrcaVersion/NProcs are execution
// facts (or run-start metadata) and deliberately not part of Fields.
func fromStatusUpdate(u tracker.StatusUpdate) Fields {
	var imag *float64
	if u.ImaginaryModes != nil {
		f := float64(*u.ImaginaryModes)
		imag = &f
	}
	return Fields{
		LastEnergy:     u.LastEnergy,
		WallclockSec:   u.WallclockSec,
		Converged:      u.Converged,
		OptMaxCycles:   u.OptMaxCycles,
		ImaginaryModes: imag,
		ZPEEh:          u.ZPEEh,
		EnthalpyEh:     u.EnthalpyEh,
		EntropyCorrEh:  u.EntropyCorrEh,
		GibbsEh:        u.GibbsEh,
		GMinusEEh:      u.GMinusEEh,
		S2:             u.S2,
		S2Ideal:        u.S2Ideal,
		ErrorClass:     u.ErrorClass,
		ErrorExcerpt:   u.ErrorExcerpt,
	}
}

// Change is one drifted field: its wire name, display values, and the value
// to send to reimport:apply (nil means "clear the stored field", which the
// mutation encodes as an explicit JSON null).
type Change struct {
	Field string
	Old   string // stored value, "—" when absent
	New   string // recomputed value, "—" when absent (a clear)
	Wire  any    // value for the patch; nil → clear
}

// fieldDef wires one Fields member to its comparison and formatting. The
// accessor indirection keeps Diff a single loop instead of fourteen copies of
// the same compare-and-append.
type fieldDef struct {
	name   string
	policy FieldPolicy
	get    func(f *Fields) (value any, present bool)
}

func floatField(name string, policy FieldPolicy, get func(f *Fields) *float64) fieldDef {
	return fieldDef{name, policy, func(f *Fields) (any, bool) {
		if p := get(f); p != nil {
			return *p, true
		}
		return nil, false
	}}
}

func boolField(name string, get func(f *Fields) *bool) fieldDef {
	return fieldDef{name, PolicyVerdict, func(f *Fields) (any, bool) {
		if p := get(f); p != nil {
			return *p, true
		}
		return nil, false
	}}
}

func stringField(name string, get func(f *Fields) *string) fieldDef {
	return fieldDef{name, PolicyVerdict, func(f *Fields) (any, bool) {
		if p := get(f); p != nil {
			return *p, true
		}
		return nil, false
	}}
}

// fieldDefs enumerates every reimport-owned field exactly once; Diff and
// Patch both walk it, so a field added here is automatically compared,
// reported and patched — and a field NOT here can never be touched.
var fieldDefs = []fieldDef{
	boolField("converged", func(f *Fields) *bool { return f.Converged }),
	boolField("optMaxCycles", func(f *Fields) *bool { return f.OptMaxCycles }),
	floatField("imaginaryModes", PolicyVerdict, func(f *Fields) *float64 { return f.ImaginaryModes }),
	stringField("errorClass", func(f *Fields) *string { return f.ErrorClass }),
	stringField("errorExcerpt", func(f *Fields) *string { return f.ErrorExcerpt }),
	floatField("zpeEh", PolicyVerdict, func(f *Fields) *float64 { return f.ZPEEh }),
	floatField("enthalpyEh", PolicyVerdict, func(f *Fields) *float64 { return f.EnthalpyEh }),
	floatField("entropyCorrEh", PolicyVerdict, func(f *Fields) *float64 { return f.EntropyCorrEh }),
	floatField("gibbsEh", PolicyVerdict, func(f *Fields) *float64 { return f.GibbsEh }),
	floatField("gMinusEEh", PolicyVerdict, func(f *Fields) *float64 { return f.GMinusEEh }),
	floatField("s2", PolicyVerdict, func(f *Fields) *float64 { return f.S2 }),
	floatField("s2Ideal", PolicyVerdict, func(f *Fields) *float64 { return f.S2Ideal }),
	floatField("lastEnergy", PolicyMeasurement, func(f *Fields) *float64 { return f.LastEnergy }),
	floatField("wallclockSec", PolicyMeasurement, func(f *Fields) *float64 { return f.WallclockSec }),
}

const absentMark = "—"

func display(v any, present bool) string {
	if !present {
		return absentMark
	}
	switch x := v.(type) {
	case bool:
		return strconv.FormatBool(x)
	case int:
		return strconv.Itoa(x)
	case float64:
		return strconv.FormatFloat(x, 'g', -1, 64)
	case string:
		if len(x) > 40 {
			return strconv.Quote(x[:37] + "...")
		}
		return strconv.Quote(x)
	default:
		return fmt.Sprintf("%v", x)
	}
}

// Diff compares stored against freshly recomputed fields and returns every
// change the policies allow, in fieldDefs order (stable output). An empty
// result means the row already matches the current parser — the idempotent
// no-op case.
func Diff(stored, fresh Fields) []Change {
	var out []Change
	for _, d := range fieldDefs {
		oldV, oldOK := d.get(&stored)
		newV, newOK := d.get(&fresh)
		if oldOK == newOK && oldV == newV {
			continue // identical (both absent, or equal values)
		}
		if d.policy == PolicyMeasurement && !newOK {
			continue // measurements are never erased by a failed re-derivation
		}
		out = append(out, Change{
			Field: d.name,
			Old:   display(oldV, oldOK),
			New:   display(newV, newOK),
			Wire:  newV, // nil when the recompute cleared the field
		})
	}
	return out
}

// Patch converts a Diff result into the argument map for reimport:apply. A
// nil Wire value marshals as JSON null, which the mutation interprets as
// "clear the stored field".
func Patch(changes []Change) map[string]any {
	out := make(map[string]any, len(changes))
	for _, c := range changes {
		out[c.Field] = c.Wire
	}
	return out
}

// Summary formats one run's drift as "field: old → new" fragments for the
// report table.
func Summary(changes []Change) string {
	parts := make([]string, len(changes))
	for i, c := range changes {
		parts[i] = fmt.Sprintf("%s: %s → %s", c.Field, c.Old, c.New)
	}
	return strings.Join(parts, ", ")
}
