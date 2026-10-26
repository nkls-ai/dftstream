package tracker

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/nkls-ai/dftstream/internal/levels"
)

func (c *ConvexHTTPTracker) EnsureExperiment(ctx context.Context, orgID, name string) (ExperimentID, error) {
	args := map[string]any{"name": name}
	orgID, err := c.resolveOrg(ctx, orgID)
	if err != nil {
		return "", err
	}
	if orgID != "" {
		args["organizationId"] = orgID
	}
	raw, err := c.mutation(ctx, fnExperimentsEnsure, args)
	if err != nil {
		return "", err
	}
	var id string
	if err := json.Unmarshal(raw, &id); err != nil {
		return "", fmt.Errorf("EnsureExperiment: %w", err)
	}
	return ExperimentID(id), nil
}

func (c *ConvexHTTPTracker) EnsureBatch(ctx context.Context, expID ExperimentID, name string, artifactLevel levels.ArtifactLevel) (BatchID, error) {
	args := map[string]any{
		"experimentId":  string(expID),
		"name":          name,
		"artifactLevel": artifactLevel.String(),
	}
	raw, err := c.mutation(ctx, fnExperimentsEnsureBatch, args)
	if err != nil {
		return "", err
	}
	var id string
	if err := json.Unmarshal(raw, &id); err != nil {
		return "", fmt.Errorf("EnsureBatch: %w", err)
	}
	return BatchID(id), nil
}

func (c *ConvexHTTPTracker) FindRunByName(ctx context.Context, expID ExperimentID, name string) (RunID, error) {
	raw, err := c.query(ctx, fnRunsFindByExperimentName, map[string]any{
		"experimentId": string(expID),
		"name":         name,
	})
	if err != nil {
		return "", err
	}
	if string(raw) == "null" {
		return "", nil
	}
	var row struct {
		ID string `json:"_id"`
	}
	if err := json.Unmarshal(raw, &row); err != nil {
		return "", fmt.Errorf("FindRunByName: %w", err)
	}
	return RunID(row.ID), nil
}

func (c *ConvexHTTPTracker) CreateRun(ctx context.Context, r RunCreate) (RunID, error) {
	raw, err := c.mutation(ctx, fnRunsCreate, runCreateArgs(r))
	if err != nil {
		return "", err
	}
	var id string
	if err := json.Unmarshal(raw, &id); err != nil {
		return "", fmt.Errorf("CreateRun: %w", err)
	}
	return RunID(id), nil
}

// runCreateArgs converts a RunCreate to the runs:create wire args. Shared by
// the live path and the spool replay path so the two can never drift.
func runCreateArgs(r RunCreate) map[string]any {
	args := map[string]any{"experimentId": r.ExperimentID}
	putNonEmpty(args, "batchId", string(r.BatchID))
	putNonEmptyMap(args, "batchParams", r.BatchParams)
	putNonEmpty(args, "name", r.Name)
	putNonEmpty(args, "hostname", r.Hostname)
	putPositive(args, "ncores", r.NCores)
	putPositive(args, "nprocs", r.NProcs)
	putPositive(args, "maxcoreMb", r.MaxCoreMB)
	putNonEmpty(args, "orcaVersion", r.OrcaVersion)
	putNonEmpty(args, "jobType", r.JobType)
	putNonEmpty(args, "inputPath", r.InputPath)
	putNonEmpty(args, "inputText", r.InputText)
	putNonEmpty(args, "cwd", r.CWD)
	putNonEmptySlice(args, "keywords", r.Keywords)
	putNonEmpty(args, "functional", r.Functional)
	putNonEmpty(args, "basis", r.Basis)
	putNonEmpty(args, "method", r.Method)
	putNonEmptySlice(args, "runTypes", r.RunTypes)
	putNonEmpty(args, "scfTier", r.ScfTier)
	putNonEmpty(args, "optTier", r.OptTier)
	putNonEmpty(args, "grid", r.Grid)
	putNonNil(args, "charge", r.Charge)
	putNonNil(args, "mult", r.Mult)
	putNonEmpty(args, "solvent", r.Solvent)
	putNonEmpty(args, "solventModel", r.SolventModel)
	putNonEmptySlice(args, "corrections", r.Corrections)
	putNonEmpty(args, "submittedBy", r.SubmittedBy)
	putNonEmpty(args, "dftstreamVersion", r.DFTStreamVersion)
	putNonEmpty(args, "schedulerJobId", r.SchedulerJobID)
	putNonEmpty(args, "parentRunId", string(r.ParentRunID))
	if r.ParentRunID != "" {
		putNonEmpty(args, "parentEdgeKind", r.ParentEdgeKind)
	}
	return args
}

func (c *ConvexHTTPTracker) UpdateRunStatus(ctx context.Context, runID RunID, u StatusUpdate) error {
	args := map[string]any{"runId": runID}
	putNonEmpty(args, "status", string(u.Status))
	putNonNil(args, "exitCode", u.ExitCode)
	if u.FinishedAt != nil {
		args["finishedAt"] = u.FinishedAt.UnixMilli()
	}
	putNonNil(args, "lastEnergy", u.LastEnergy)
	putNonNil(args, "orcaVersion", u.OrcaVersion)
	putNonNil(args, "nprocs", u.NProcs)
	putNonNil(args, "wallclockSec", u.WallclockSec)
	putNonNil(args, "converged", u.Converged)
	putNonNil(args, "optMaxCycles", u.OptMaxCycles)
	putNonNil(args, "imaginaryModes", u.ImaginaryModes)
	putNonNil(args, "zpeEh", u.ZPEEh)
	putNonNil(args, "enthalpyEh", u.EnthalpyEh)
	putNonNil(args, "entropyCorrEh", u.EntropyCorrEh)
	putNonNil(args, "gibbsEh", u.GibbsEh)
	putNonNil(args, "gMinusEEh", u.GMinusEEh)
	putNonNil(args, "s2", u.S2)
	putNonNil(args, "s2Ideal", u.S2Ideal)
	putNonNil(args, "errorClass", u.ErrorClass)
	putNonNil(args, "errorExcerpt", u.ErrorExcerpt)
	_, err := c.mutation(ctx, fnRunsUpdateStatus, args)
	return err
}

func putNonEmpty(args map[string]any, key, v string) {
	if v != "" {
		args[key] = v
	}
}

func putPositive(args map[string]any, key string, v int) {
	if v > 0 {
		args[key] = v
	}
}

func putNonEmptySlice(args map[string]any, key string, v []string) {
	if len(v) > 0 {
		args[key] = v
	}
}

func putNonEmptyMap(args map[string]any, key string, v map[string]any) {
	if len(v) > 0 {
		args[key] = v
	}
}

func putNonNil[T any](args map[string]any, key string, v *T) {
	if v != nil {
		args[key] = *v
	}
}

// AppendEvent / AppendMetric / AppendSysSample are intended to be hit
// only through BatchingTracker — sending one row per HTTP call is
// wasteful. We still expose them for ad-hoc use.
func (c *ConvexHTTPTracker) AppendEvent(ctx context.Context, runID RunID, e Event) error {
	return c.AppendEvents(ctx, runID, []Event{e})
}

// AppendEvents is the bulk half of AppendEvent (see BulkAppender).
func (c *ConvexHTTPTracker) AppendEvents(ctx context.Context, runID RunID, events []Event) error {
	if len(events) == 0 {
		return nil
	}
	_, err := c.mutation(ctx, fnEventsAppendMany, map[string]any{
		"runId": runID,
		"items": eventItems(events),
	})
	return err
}

// eventItems converts events to their appendMany wire shape. Shared by the
// live path and the spool replay path so the two can never drift.
func eventItems(events []Event) []map[string]any {
	items := make([]map[string]any, len(events))
	for i, e := range events {
		payload := e.Payload
		if payload == nil {
			payload = map[string]any{}
		}
		items[i] = map[string]any{
			"seq":     e.Seq,
			"ts":      e.TS.UnixMilli(),
			"kind":    e.Kind,
			"payload": payload,
		}
	}
	return items
}

func (c *ConvexHTTPTracker) AppendMetric(ctx context.Context, runID RunID, m Metric) error {
	return c.AppendMetrics(ctx, runID, []Metric{m})
}

// AppendMetrics is the bulk half of AppendMetric (see BulkAppender).
func (c *ConvexHTTPTracker) AppendMetrics(ctx context.Context, runID RunID, metrics []Metric) error {
	if len(metrics) == 0 {
		return nil
	}
	_, err := c.mutation(ctx, fnMetricsAppendMany, map[string]any{
		"runId": runID,
		"items": metricItems(metrics),
	})
	return err
}

// metricItems converts metrics to their appendMany wire shape.
func metricItems(metrics []Metric) []map[string]any {
	items := make([]map[string]any, len(metrics))
	for i, m := range metrics {
		obj := map[string]any{
			"key":   m.Key,
			"ts":    m.TS.UnixMilli(),
			"value": m.Value,
		}
		if m.Cycle != nil {
			obj["cycle"] = *m.Cycle
		}
		if m.Iter != nil {
			obj["iter"] = *m.Iter
		}
		items[i] = obj
	}
	return items
}

func (c *ConvexHTTPTracker) AppendGeometry(ctx context.Context, runID RunID, cycle int, xyz string) error {
	_, err := c.mutation(ctx, fnGeometriesAppend, map[string]any{
		"runId": runID, "cycle": cycle, "xyz": xyz,
	})
	return err
}

func (c *ConvexHTTPTracker) SetFrequencies(ctx context.Context, runID RunID, items []Frequency) error {
	out := make([]map[string]any, len(items))
	for i, f := range items {
		m := map[string]any{
			"idx":        f.Idx,
			"wavenumber": f.Wavenumber,
			"imaginary":  f.Imaginary,
		}
		if f.IRIntensity != 0 {
			m["irIntensity"] = f.IRIntensity
		}
		out[i] = m
	}
	args := map[string]any{"runId": runID, "items": out}
	if len(items) > 0 && items[0].HessIdx > 0 {
		args["hessIdx"] = items[0].HessIdx
	}
	_, err := c.mutation(ctx, fnFrequenciesSetAll, args)
	return err
}

func (c *ConvexHTTPTracker) AppendSysSample(ctx context.Context, runID RunID, s SysSample) error {
	return c.AppendSysSamples(ctx, runID, []SysSample{s})
}

// AppendSysSamples is the bulk half of AppendSysSample (see BulkAppender).
func (c *ConvexHTTPTracker) AppendSysSamples(ctx context.Context, runID RunID, samples []SysSample) error {
	if len(samples) == 0 {
		return nil
	}
	_, err := c.mutation(ctx, fnSysSamplesAppendMany, map[string]any{
		"runId": runID,
		"items": sysSampleItems(samples),
	})
	return err
}

// sysSampleItems converts samples to their appendMany wire shape.
func sysSampleItems(samples []SysSample) []map[string]any {
	items := make([]map[string]any, len(samples))
	for i, s := range samples {
		items[i] = map[string]any{
			"ts":      s.TS.UnixMilli(),
			"cpuPct":  s.CPUPct,
			"rssMb":   s.RSSMB,
			"threads": s.Threads,
		}
	}
	return items
}

func (c *ConvexHTTPTracker) AppendLogs(ctx context.Context, runID RunID, entries []LogEntry) error {
	if len(entries) == 0 {
		return nil
	}
	_, err := c.mutation(ctx, fnLogsAppendMany, map[string]any{
		"runId": runID,
		"items": logItems(entries),
	})
	return err
}

// logItems converts log entries to their appendMany wire shape.
func logItems(entries []LogEntry) []map[string]any {
	items := make([]map[string]any, len(entries))
	for i, e := range entries {
		obj := map[string]any{
			"ts":      e.TS.UnixMilli(),
			"level":   e.Level,
			"message": e.Message,
		}
		if len(e.Fields) > 0 {
			obj["fields"] = e.Fields
		}
		items[i] = obj
	}
	return items
}

func (c *ConvexHTTPTracker) SetExcitedStates(ctx context.Context, runID RunID, items []ExcitedState) error {
	out := make([]map[string]any, len(items))
	for i, s := range items {
		m := map[string]any{
			"idx":          s.Idx,
			"energyEv":     s.EnergyEV,
			"wavelengthNm": s.WavelengthNM,
			"oscStrength":  s.OscStrength,
		}
		if len(s.Transitions) > 0 {
			type jt struct {
				From  string  `json:"from"`
				To    string  `json:"to"`
				Coeff float64 `json:"coeff"`
			}
			arr := make([]jt, len(s.Transitions))
			for j, t := range s.Transitions {
				arr[j] = jt{From: t.From, To: t.To, Coeff: t.Coeff}
			}
			b, err := json.Marshal(arr)
			if err != nil {
				// Marshal only fails on NaN/Inf coefficients from a broken
				// parse; drop the transitions rather than lose the state row.
				c.warnf("excited state %d: could not encode transitions: %v", s.Idx, err)
			} else {
				m["transitions"] = string(b)
			}
		}
		out[i] = m
	}
	_, err := c.mutation(ctx, fnExcitedStatesSetAll, map[string]any{
		"runId": runID, "items": out,
	})
	return err
}

func (c *ConvexHTTPTracker) SetNMRShields(ctx context.Context, runID RunID, items []NMRShield) error {
	out := make([]map[string]any, len(items))
	for i, s := range items {
		out[i] = map[string]any{
			"atomIdx":    s.AtomIdx,
			"element":    s.Element,
			"isotropic":  s.Isotropic,
			"anisotropy": s.Anisotropy,
		}
	}
	_, err := c.mutation(ctx, fnNMRShieldsSetAll, map[string]any{
		"runId": runID, "items": out,
	})
	return err
}
