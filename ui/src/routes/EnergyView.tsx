import { useMemo, useState } from "react";
import { routes } from "../lib/routes";
import { Link } from "react-router-dom";
import type { Run } from "../data/types";
import type { RunResult, EnergyRow } from "../lib/energyTable";
import { energyCSV, energyRows } from "../lib/energyTable";
import { EMPTY_ENERGY, energyUnitLabel, formatRelEnergy } from "../lib/energyUnits";
import { useSettings } from "../lib/settings";
import { downloadText } from "../lib/download";
import { reportError } from "../lib/errorReporting";
import { useDataSource } from "../data/DataSource";
import { parseThermo } from "./runDetailParsers";
import { Callout } from "./runDetailUi";
import type { SortAccessors } from "../lib/tableSort";
import { useTableSort } from "../hooks/useTableSort";
import { SortableTh } from "../components/SortableTh";
import { filterRuns } from "./runsTableFilter";
import {
  TRUNCATION_TITLE,
  filteredCountLabel,
  relativeEnergyCaveat,
} from "../lib/truncation";
import { useEhFormatter } from "../lib/useEnergyFormat";
import { gMinusElectronicEh } from "../lib/thermo";

const RESULT_META: Record<RunResult, { cls: string; label: string; title: string }> = {
  OK: { cls: "conv-ok", label: "OK", title: "Finished, converged, clean spectrum (or valid TS)" },
  IMAG: { cls: "conv-warn", label: "Imag", title: "Wrong imaginary-mode count — minimum with imaginary modes, or OptTS without exactly one" },
  FREQ_BROKE: { cls: "conv-warn", label: "Freq broke", title: "Optimization converged but the run died afterwards — geometry is usable, redo the frequency step" },
  OPT_BROKE: { cls: "conv-noconv", label: "Opt broke", title: "Optimizer never converged (crashed or hit max cycles)" },
  FAILED: { cls: "conv-failed", label: "Failed", title: "Run died" },
  RUNNING: { cls: "conv-running", label: "Running", title: "Still in flight" },
};

const RESULT_ORDER: RunResult[] = ["OK", "IMAG", "FREQ_BROKE", "OPT_BROKE", "FAILED", "RUNNING"];

function ResultBadge({ result, status, optMaxCycles }: { result: RunResult; status: Run["status"]; optMaxCycles?: boolean }) {
  const m = RESULT_META[result];
  // For OPT_BROKE tell the two failure modes apart: the explicit
  // optMaxCycles flag (persisted from ORCA's "did not converge" message)
  // when present, run status as the legacy fallback.
  const maxCycles = optMaxCycles ?? status === "finished";
  const label = result === "OPT_BROKE" && maxCycles ? "Max cycles" : m.label;
  const title =
    result === "OPT_BROKE"
      ? maxCycles
        ? "Optimizer hit the maximum number of cycles — stalled, not crashed; `dftstream restart` continues from the last geometry"
        : "Run crashed mid-optimization"
      : m.title;
  return (
    <span className={`conv-badge ${m.cls}`} title={title}>
      {label}
    </span>
  );
}

/**
 * Energy cell in Hartree: displays rounded, clicking copies the
 * full-precision value to the clipboard.
 */
function EhCell({ value }: { value: number | undefined }) {
  const fmtEh = useEhFormatter();
  if (value == null) return <td className="mono">{EMPTY_ENERGY}</td>;
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(String(value));
    } catch (err) {
      reportError(err, { source: "energy-view", action: "copy energy to clipboard" });
    }
  };
  return (
    <td className="mono copy-cell" title="Click to copy" onClick={onClick}>
      {fmtEh(value)}
    </td>
  );
}

// Column key -> sort value. Natural order (sort cleared) is the
// lowest-energy-first ordering energyRows() already produces.
const ENERGY_ACCESSORS: SortAccessors<EnergyRow> = {
  name: (row) => row.run.name ?? row.run.id,
  job: (row) => row.run.jobType,
  result: (row) => row.result,
  eEl: (row) => row.run.lastEnergy,
  dE: (row) => row.relEEh,
  g: (row) => row.run.gibbsEh,
  dG: (row) => row.relGEh,
  gMinusE: (row) => gMinusElectronicEh(row.run),
};

type BackfillState =
  | { phase: "idle" }
  | { phase: "running"; done: number; total: number }
  | { phase: "done"; filled: number; missing: number; failed: number };

// A run that could have thermochemistry but whose record lacks it: it was
// tracked before the wrapper persisted thermo (or by an older importer).
// SP-and-friends without a Freq are excluded — they legitimately have none.
function missingThermo(r: Run): boolean {
  return (
    r.gibbsEh == null &&
    r.status === "finished" &&
    /FREQ/i.test(`${r.jobType ?? ""} ${(r.runTypes ?? []).join(" ")}`)
  );
}

// Cross-run energy comparison: every run of the experiment in one sortable
// scale (ΔG when Gibbs is available, ΔE otherwise), with result filters,
// row selection, and a filter/selection-aware CSV export.
export function EnergyView({
  expId,
  runs,
  capped = false,
}: {
  expId: string;
  runs: Run[];
  /** True when `runs` is the backend-capped newest slice of the experiment.
   *  The ΔE/ΔG zero point is the minimum of this array, so a truncated-away
   *  global minimum offsets every relative energy in the table — that has to
   *  be stated, not left for the chemist to discover. */
  capped?: boolean;
}) {
  const ds = useDataSource();
  const [settings] = useSettings();
  const unit = settings.energyUnit;
  const rows = useMemo(() => energyRows(runs), [runs]);
  const table = useTableSort("energy");
  const [activeResults, setActiveResults] = useState<ReadonlySet<RunResult>>(new Set());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [backfill, setBackfill] = useState<BackfillState>({ phase: "idle" });
  const [query, setQuery] = useState("");

  const resultCounts = useMemo(() => {
    const counts = new Map<RunResult, number>();
    for (const row of rows) counts.set(row.result, (counts.get(row.result) ?? 0) + 1);
    return counts;
  }, [rows]);

  // Text filter (same matcher as the runs table: name, method, basis,
  // solvent, keywords, tags, submitter) composes with the result chips.
  // Relative energies stay referenced to the whole run set — filtering
  // changes what you see, not the ΔE/ΔG zero point.
  const filtered = useMemo(() => {
    const byResult =
      activeResults.size === 0 ? rows : rows.filter((r) => activeResults.has(r.result));
    if (!query.trim()) return byResult;
    const matching = new Set(filterRuns(byResult.map((r) => r.run), query).map((r) => r.id));
    return byResult.filter((r) => matching.has(r.run.id));
  }, [rows, activeResults, query]);
  const sortedRows = table.sorted(filtered, ENERGY_ACCESSORS);
  const hasGibbs = rows.some((row) => row.run.gibbsEh != null);
  const expName = expId.slice(0, 8);

  const filteredIds = useMemo(() => new Set(filtered.map((r) => r.run.id)), [filtered]);
  const selectedVisible = useMemo(
    () => new Set([...selected].filter((id) => filteredIds.has(id))),
    [selected, filteredIds],
  );
  const allVisibleSelected = filtered.length > 0 && selectedVisible.size === filtered.length;

  const toggleResult = (r: RunResult) => {
    const next = new Set(activeResults);
    if (next.has(r)) next.delete(r);
    else next.add(r);
    setActiveResults(next);
  };

  const toggleRow = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const toggleAllVisible = () => {
    const next = new Set(selected);
    if (allVisibleSelected) for (const id of filteredIds) next.delete(id);
    else for (const id of filteredIds) next.add(id);
    setSelected(next);
  };

  // Export honors the current view: the selected rows when any visible row
  // is selected, otherwise everything that passes the filters.
  const exportRows = selectedVisible.size > 0
    ? sortedRows.filter((r) => selectedVisible.has(r.run.id))
    : sortedRows;

  const backfillCandidates = useMemo(
    () => filtered.map((r) => r.run).filter(missingThermo),
    [filtered],
  );

  // Fetches each candidate's .out, parses the final thermochemistry
  // section client-side, and persists it onto the run record — a one-time
  // repair for runs tracked before the wrapper stored thermo.
  const runBackfill = async () => {
    const candidates = backfillCandidates;
    setBackfill({ phase: "running", done: 0, total: candidates.length });
    let done = 0;
    let filled = 0;
    let missing = 0;
    let failed = 0;
    for (const run of candidates) {
      try {
        const text = await ds.fetchRunOutputText(run.id);
        const thermo = text ? parseThermo(text) : null;
        if (thermo?.gibbsEh != null) {
          await ds.patchRunThermo(run.id, {
            zpeEh: thermo.zpeEh ?? undefined,
            enthalpyEh: thermo.enthalpyEh ?? undefined,
            entropyCorrEh: thermo.entropyEh ?? undefined,
            gibbsEh: thermo.gibbsEh,
            gMinusEEh: thermo.gMinusEEh ?? undefined,
          });
          filled++;
        } else {
          missing++;
        }
      } catch (err) {
        failed++;
        reportError(err, { source: "energy-view", action: `backfill thermo for ${run.id}` });
      }
      done++;
      setBackfill({ phase: "running", done, total: candidates.length });
    }
    setBackfill({ phase: "done", filled, missing, failed });
  };

  if (rows.length === 0) {
    return <div className="empty-state">No runs in this experiment yet.</div>;
  }

  const relLabel = energyUnitLabel(unit);
  const isFiltered = activeResults.size > 0 || query.trim() !== "";
  const exportLabel =
    selectedVisible.size > 0
      ? `Export CSV (${selectedVisible.size} selected)`
      : isFiltered
        ? `Export CSV (${filtered.length} filtered)`
        : "Export CSV";

  return (
    <section>
      <div className="batch-toolbar table-toolbar">
        <input
          type="search"
          placeholder="Filter runs…"
          aria-label="Filter runs by name, method, basis, tags"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="energy-filter-chips">
          {RESULT_ORDER.map((r) => {
            const count = resultCounts.get(r) ?? 0;
            if (count === 0) return null;
            const m = RESULT_META[r];
            return (
              <button
                key={r}
                type="button"
                className={
                  `conv-badge ${m.cls} energy-filter-chip` +
                  (activeResults.has(r) ? " active" : "")
                }
                title={`${m.title} — click to filter`}
                onClick={() => toggleResult(r)}
              >
                {m.label} · {count}
              </button>
            );
          })}
          {isFiltered && (
            <button
              type="button"
              className="dl-btn"
              onClick={() => {
                setActiveResults(new Set());
                setQuery("");
              }}
            >
              Clear filters
            </button>
          )}
        </div>
        <div className="batch-export">
          {backfillCandidates.length > 0 && backfill.phase !== "running" && (
            <button
              type="button"
              className="dl-btn"
              title="Fetch the .out of runs missing thermochemistry, parse the final THERMOCHEMISTRY section, and store it on the run — fills blank Gibbs columns for runs tracked before thermo was recorded."
              onClick={() => {
                runBackfill().catch((err) =>
                  reportError(err, { source: "energy-view", action: "thermo backfill" }),
                );
              }}
            >
              Fetch missing thermo ({backfillCandidates.length})
            </button>
          )}
          {backfill.phase === "running" && (
            <span className="muted">
              Fetching thermo… {backfill.done}/{backfill.total}
            </span>
          )}
          {backfill.phase === "done" && (
            <span className="muted" title="filled = thermo stored on the run; none found = the .out has no usable final thermochemistry section">
              Thermo: {backfill.filled} filled
              {backfill.missing > 0 ? `, ${backfill.missing} none found` : ""}
              {backfill.failed > 0 ? `, ${backfill.failed} failed` : ""}
            </span>
          )}
          <button
            type="button"
            className="dl-btn"
            onClick={() => downloadText(`energies-${expName}.csv`, energyCSV(exportRows, unit))}
          >
            {exportLabel}
          </button>
        </div>
      </div>

      <div className="muted" style={{ margin: "6px 0" }}>
        {filteredCountLabel(filtered.length, rows.length, capped)} · relative energies
        in {relLabel} vs. lowest{hasGibbs ? " · ΔG from Gibbs where available" : ""}
      </div>
      {capped && (
        <Callout tone="warn">
          <span title={TRUNCATION_TITLE}>{relativeEnergyCaveat(true)}</span>
        </Callout>
      )}

      <table className="table batch-table">
        <thead>
          <tr>
            <th style={{ width: 28 }}>
              <input
                type="checkbox"
                checked={allVisibleSelected}
                onChange={toggleAllVisible}
                title={allVisibleSelected ? "Deselect all visible" : "Select all visible"}
                aria-label={allVisibleSelected ? "Deselect all visible runs" : "Select all visible runs"}
              />
            </th>
            <SortableTh label="Name" sortKey="name" table={table} />
            <SortableTh label="Job" sortKey="job" table={table} />
            <SortableTh label="Result" sortKey="result" table={table} />
            <SortableTh label="E(el) (Eh)" sortKey="eEl" table={table} />
            <SortableTh label={`ΔE (${relLabel})`} sortKey="dE" table={table} />
            {hasGibbs && <SortableTh label="Gibbs G (Eh)" sortKey="g" table={table} />}
            {hasGibbs && <SortableTh label={`ΔG (${relLabel})`} sortKey="dG" table={table} />}
            {hasGibbs && <SortableTh label="G − E(el) (Eh)" sortKey="gMinusE" table={table} />}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map(({ run: r, result, relEEh, relGEh }) => (
            <tr key={r.id}>
              <td>
                <input
                  type="checkbox"
                  checked={selected.has(r.id)}
                  onChange={() => toggleRow(r.id)}
                  aria-label={`Select ${r.name ?? r.id}`}
                />
              </td>
              <td>
                <Link to={routes.run(expId, r.id)}>
                  {r.name ?? r.id.slice(0, 10)}
                </Link>
              </td>
              <td className="mono">{r.jobType ?? "-"}</td>
              <td>
                <ResultBadge result={result} status={r.status} optMaxCycles={r.optMaxCycles} />
              </td>
              <EhCell value={r.lastEnergy} />
              <td className="mono">{formatRelEnergy(unit, relEEh)}</td>
              {hasGibbs && <EhCell value={r.gibbsEh} />}
              {hasGibbs && (
                <td className="mono">{formatRelEnergy(unit, relGEh)}</td>
              )}
              {hasGibbs && <EhCell value={gMinusElectronicEh(r)} />}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
