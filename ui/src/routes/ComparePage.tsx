import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useDataSource } from "../data/DataSource";
import type { Run } from "../data/types";
import {
  compareBasketClear,
  compareBasketRemove,
  useCompareBasket,
} from "../lib/compareBasket";
import { energyCSV, energyRows } from "../lib/energyTable";
import { energyUnitLabel, formatRelEnergy } from "../lib/energyUnits";
import { downloadText } from "../lib/download";
import { reportError } from "../lib/errorReporting";
import { useSettings } from "../lib/settings";
import { routes } from "../lib/routes";
import { orgQueryArg, useOrg } from "../auth/OrgContext";
import { methodHeadline } from "./runHeadline";
import { useEhFormatter } from "../lib/useEnergyFormat";

/**
 * Cross-experiment comparison of the runs collected in the compare
 * basket: one relative-energy scale across everything in the basket,
 * regardless of which experiment each run lives in.
 */
export function ComparePage() {
  const ds = useDataSource();
  const [settings] = useSettings();
  const unit = settings.energyUnit;
  const fmtEh = useEhFormatter();
  const ids = useCompareBasket();
  const org = useOrg();
  const experiments = ds.useExperiments(orgQueryArg(org));
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(false);

  const idsKey = ids.join(",");
  useEffect(() => {
    let alive = true;
    if (ids.length === 0) {
      setRuns([]);
      return;
    }
    setLoading(true);
    Promise.all(
      ids.map((id) =>
        ds.fetchRun(id).catch((err) => {
          reportError(err, { source: "compare-page", action: `fetch run ${id}` });
          return null;
        }),
      ),
    ).then((rs) => {
      if (!alive) return;
      setRuns(rs.filter((r): r is Run => r != null));
      setLoading(false);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, ds]);

  const expNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of experiments.data ?? []) m.set(e.id, e.name);
    return m;
  }, [experiments.data]);

  const rows = useMemo(() => energyRows(runs), [runs]);
  const hasGibbs = rows.some((row) => row.run.gibbsEh != null);
  const relLabel = energyUnitLabel(unit);

  const header = (
    <div className="page-header">
      <div>
        <h1>Compare</h1>
        <div className="subtitle">cross-experiment energy comparison</div>
      </div>
    </div>
  );

  if (ids.length === 0) {
    return (
      <div>
        {header}
        <div className="empty-state">
          The compare basket is empty. Use the <strong>⇄</strong> toggle on any
          run (runs table or run header) to collect runs — across
          experiments — then compare their energies here.
        </div>
      </div>
    );
  }

  return (
    <div>
      {header}
      <div className="batch-toolbar">
        <span className="muted">
          {rows.length} of {ids.length} run{ids.length === 1 ? "" : "s"} loaded ·
          relative energies in {relLabel} vs. lowest
          {loading ? " · loading…" : ""}
        </span>
        <div className="batch-export">
          <button
            type="button"
            className="dl-btn"
            onClick={() => downloadText("compare.csv", energyCSV(rows, unit))}
          >
            Export CSV
          </button>
          <button type="button" className="dl-btn" onClick={compareBasketClear}>
            Clear basket
          </button>
        </div>
      </div>

      <table className="table batch-table">
        <thead>
          <tr>
            <th />
            <th>Name</th>
            <th>Experiment</th>
            <th>Method</th>
            <th>E(el) (Eh)</th>
            <th>ΔE ({relLabel})</th>
            {hasGibbs && <th>Gibbs G (Eh)</th>}
            {hasGibbs && <th>ΔG ({relLabel})</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ run: r, relEEh, relGEh }) => (
            <tr key={r.id}>
              <td>
                <button
                  type="button"
                  className="run-tag-remove"
                  title="Remove from comparison"
                  aria-label={`Remove ${r.name ?? r.id} from comparison`}
                  onClick={() => compareBasketRemove(r.id)}
                >
                  ×
                </button>
              </td>
              <td>
                <Link to={routes.run(r.experimentId, r.id)}>
                  {r.name ?? r.id.slice(0, 10)}
                </Link>
              </td>
              <td className="dim">
                {expNames.get(r.experimentId) ?? r.experimentId.slice(0, 8)}
              </td>
              <td className="mono">{methodHeadline(r)}</td>
              <td className="mono">{fmtEh(r.lastEnergy)}</td>
              <td className="mono">{formatRelEnergy(unit, relEEh)}</td>
              {hasGibbs && (
                <td className="mono">{fmtEh(r.gibbsEh)}</td>
              )}
              {hasGibbs && (
                <td className="mono">{formatRelEnergy(unit, relGEh)}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="dim" style={{ marginTop: 8, fontSize: 12 }}>
        Comparing energies across different methods/basis sets is only
        meaningful when the level of theory matches — the Method column is
        there to catch apples vs. oranges.
      </div>
    </div>
  );
}

/** Floating pill shown while the basket has runs — jumps to /compare. */
export function CompareBasketPill() {
  const ids = useCompareBasket();
  if (ids.length === 0) return null;
  return (
    <Link to={routes.compare} className="compare-pill" title="Open comparison">
      ⇄ Compare ({ids.length})
    </Link>
  );
}
