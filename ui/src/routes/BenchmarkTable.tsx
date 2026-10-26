import { useMemo } from "react";
import { Link } from "react-router-dom";
import { routes } from "../lib/routes";
import { RunStatusBadge } from "../components/RunStatusBadge";
import { RunChips } from "../components/KeywordChips";
import { formatDurationMs } from "../lib/time";
import type { Run } from "../data/types";
import type { MethodGroup } from "../lib/benchmarkUtils";
import { lowestEnergyRun } from "../lib/runSelect";
import type { SortAccessors } from "../lib/tableSort";
import { useTableSort } from "../hooks/useTableSort";
import { SortableTh } from "../components/SortableTh";
import { useEhFormatter } from "../lib/useEnergyFormat";

interface BenchmarkRow {
  g: MethodGroup;
  bestRun: Run;
}

// Column key -> sort value. Natural order (sort cleared) is the incoming
// MethodGroup order.
const BENCHMARK_ACCESSORS: SortAccessors<BenchmarkRow> = {
  method: (row) => row.g.functional,
  basis: (row) => row.g.basis,
  dE: (row) => row.g.relKcal,
  energy: (row) => row.g.bestEnergy,
  status: (row) => row.bestRun.status,
  duration: (row) => row.bestRun.wallclockSec,
};

/** Per-method comparison table; the reference row (ΔE = 0) is highlighted. */
export function BenchmarkTable({
  groups,
  expId,
}: {
  groups: MethodGroup[];
  expId: string;
}) {
  const table = useTableSort("benchmark");
  const fmtEh = useEhFormatter();
  const rows = useMemo<BenchmarkRow[]>(
    () => groups.map((g) => ({ g, bestRun: lowestEnergyRun(g.runs) })),
    [groups],
  );
  const sorted = table.sorted(rows, BENCHMARK_ACCESSORS);

  return (
    <table className="table">
      <thead>
        <tr>
          <SortableTh label="Method" sortKey="method" table={table} />
          <SortableTh label="Basis" sortKey="basis" table={table} />
          <SortableTh label="ΔE (kcal/mol)" sortKey="dE" table={table} />
          <SortableTh label="Energy (Eh)" sortKey="energy" table={table} />
          <SortableTh label="Status" sortKey="status" table={table} />
          <th>Keywords</th>
          <SortableTh label="Duration" sortKey="duration" table={table} defaultDir="desc" />
          <th>Run</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map(({ g, bestRun }) => {
          const isRef = Math.abs(g.relKcal) < 1e-6;
          return (
            <tr key={g.key} className={isRef ? "benchmark-ref-row" : ""}>
              <td className="mono" style={{ fontWeight: 600 }}>{g.functional}</td>
              <td className="mono">{g.basis}</td>
              <td className="mono">
                {isRef ? (
                  <span style={{ color: "var(--ok, #5eead4)" }}>0.0 (ref)</span>
                ) : (
                  g.relKcal.toFixed(2)
                )}
              </td>
              <td className="mono">{fmtEh(g.bestEnergy)}</td>
              <td><RunStatusBadge status={bestRun.status} /></td>
              <td><RunChips run={bestRun} compact /></td>
              <td className="mono muted">
                {bestRun.wallclockSec != null
                  ? formatDurationMs(bestRun.wallclockSec * 1000, { compact: true })
                  : "-"}
              </td>
              <td>
                <Link to={routes.run(expId, bestRun.id)}>
                  {bestRun.name ?? bestRun.id.slice(0, 10)}
                </Link>
                {g.runs.length > 1 && (
                  <span className="muted" style={{ fontSize: 12, marginLeft: 4 }}>
                    +{g.runs.length - 1}
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
