// Presentational half of the batch dashboard: every card here is a pure
// function of the numbers lib/batchProgress.ts derived. No queries, no
// arithmetic beyond formatting — so a metric can only be wrong in one place,
// and that place has tests.

import { Link } from "react-router-dom";
import type { BatchProgress } from "../data/types";
import { routes } from "../lib/routes";
import { formatDurationMs } from "../lib/time";
import {
  failureRows,
  groupByParam,
  MIN_ETA_SAMPLES,
  type BatchMetrics,
} from "../lib/batchProgress";
import { useEhFormatter } from "../lib/useEnergyFormat";

export function ProgressBar({ metrics }: { metrics: BatchMetrics }) {
  return (
    <div className="batch-progress">
      <div className="batch-progress-head">
        <strong>
          {metrics.terminal} / {metrics.total} done
        </strong>
        <span className="mono">{metrics.percent.toFixed(1)}%</span>
      </div>
      <div
        className="batch-progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={metrics.total}
        aria-valuenow={metrics.terminal}
      >
        <span className="batch-progress-fill ok" style={{ width: `${pct(metrics.finished, metrics.total)}%` }} />
        <span className="batch-progress-fill bad" style={{ width: `${pct(metrics.failed, metrics.total)}%` }} />
        <span className="batch-progress-fill running" style={{ width: `${pct(metrics.running, metrics.total)}%` }} />
      </div>
      <div className="batch-progress-legend muted">
        <span>{metrics.finished} finished</span>
        <span>{metrics.failed} failed</span>
        <span>{metrics.running} running</span>
        <span>{metrics.pending} pending</span>
      </div>
    </div>
  );
}

/**
 * The three numbers a screening campaign is actually steered by: how fast it
 * is finishing, when it will be done, and how many distinct molecules it
 * covers. Everything else moved behind "More statistics" — a dashboard that
 * shows eighteen numbers at once is a dashboard nobody reads.
 */
export function HeadlinePanel({
  metrics,
  molecules,
  moleculeKey,
  moleculeScope,
}: {
  metrics: BatchMetrics;
  /** Distinct values of the grouping parameter, or undefined when the batch
   *  carries no parameters to count. */
  molecules?: number;
  moleculeKey?: string;
  /** How many runs that count was taken over, since it is page-scoped. */
  moleculeScope: number;
}) {
  return (
    <div className="batch-metric-grid headline">
      <Metric
        label="Finished / hour"
        value={metrics.completionsPerHour == null ? "—" : metrics.completionsPerHour.toFixed(1)}
        sub={
          metrics.completionsPerHour == null
            ? "not enough elapsed time yet"
            : `${metrics.running} running now`
        }
      />
      <Metric
        label="Time left"
        value={
          metrics.eta
            ? `${formatDurationMs(metrics.eta.p50Sec * 1000)} – ${formatDurationMs(metrics.eta.p90Sec * 1000)}`
            : "—"
        }
        sub={etaSub(metrics)}
      />
      <Metric
        label={moleculeKey ? `Distinct ${moleculeKey}` : "Molecules"}
        value={molecules == null ? "—" : String(molecules)}
        sub={
          molecules == null
            ? "needs --batch-params, e.g. substrate=benzaldehyde"
            : `across ${moleculeScope} loaded run${moleculeScope === 1 ? "" : "s"}`
        }
      />
    </div>
  );
}

export function ThroughputPanel({ metrics }: { metrics: BatchMetrics }) {
  return (
    <div className="batch-metric-grid">
      <Metric
        label="Concurrency"
        value={String(metrics.running)}
        sub="runs in flight"
      />
      <Metric
        label="Completions / hour"
        value={metrics.completionsPerHour == null ? "—" : metrics.completionsPerHour.toFixed(1)}
        sub={metrics.completionsPerHour == null ? "not enough elapsed time" : "since the first run started"}
      />
      <Metric
        label="ETA (p50–p90)"
        value={
          metrics.eta
            ? `${formatDurationMs(metrics.eta.p50Sec * 1000)} – ${formatDurationMs(metrics.eta.p90Sec * 1000)}`
            : "—"
        }
        sub={etaSub(metrics)}
      />
      <Metric
        label="Core-hours"
        value={metrics.coreHoursUsed.toFixed(1)}
        sub={
          metrics.coreHoursProjected == null
            ? "consumed so far"
            : `used · ~${metrics.coreHoursProjected.toFixed(1)} projected for the batch`
        }
      />
    </div>
  );
}

function etaSub(metrics: BatchMetrics): string {
  if (metrics.remaining === 0) return "batch complete";
  if (!metrics.duration || metrics.duration.sampleCount < MIN_ETA_SAMPLES) {
    return `needs ${MIN_ETA_SAMPLES} finished runs (has ${metrics.finished})`;
  }
  if (!metrics.eta) return "—";
  return metrics.eta.observedConcurrency === 0
    ? `${metrics.remaining} left · nothing running, assuming 1 slot`
    : `${metrics.remaining} left at ${metrics.eta.assumedConcurrency}× concurrency`;
}

export function QualityPanel({ metrics }: { metrics: BatchMetrics }) {
  return (
    <div className="batch-metric-grid">
      <Metric label="Converged" value={percentLabel(metrics.convergedRate)} sub="of runs that reported a convergence flag" />
      <Metric label="Max opt cycles" value={percentLabel(metrics.optMaxCyclesRate)} sub="of terminal runs" />
      <Metric label="Imaginary modes" value={percentLabel(metrics.imaginaryRate)} sub="of finished runs" />
      <Metric label="Missing thermo" value={percentLabel(metrics.missingThermoRate)} sub="finished without a Gibbs energy" />
    </div>
  );
}

export function EnergyPanel({
  metrics,
  medianKcal,
  outlierCount,
  pageCount,
}: {
  metrics: BatchMetrics;
  medianKcal?: number;
  outlierCount: number;
  pageCount: number;
}) {
  const fmtEh = useEhFormatter();
  return (
    <div className="batch-metric-grid">
      <Metric
        label="Lowest energy"
        value={fmtEh(metrics.energy.minEh)}
        sub={`Eh · over ${metrics.energy.count} finished run${metrics.energy.count === 1 ? "" : "s"}`}
      />
      <Metric
        label="Mean above min"
        value={metrics.energy.spreadKcal == null ? "—" : metrics.energy.spreadKcal.toFixed(2)}
        sub="kcal/mol, batch-wide"
      />
      <Metric
        label="Median above min"
        value={medianKcal == null ? "—" : medianKcal.toFixed(2)}
        sub={`kcal/mol · ${pageCount} loaded run${pageCount === 1 ? "" : "s"}`}
      />
      <Metric
        label="Outliers"
        value={String(outlierCount)}
        sub="above q3 + 1.5·IQR of the loaded runs"
      />
    </div>
  );
}

export function FailurePanel({
  expId,
  rollup,
  failureExamples,
  pageFailures,
}: {
  expId: string;
  rollup: BatchProgress | null;
  /** One loaded failed run per rollup failure key (lib/batchStats
   *  failureExamplesByKey) — gives each aggregate row a run whose
   *  diagnosis panel can be opened. */
  failureExamples: Map<string, string>;
  pageFailures: { signature: string; count: number; exampleRunId: string }[];
}) {
  const rows = rollup ? failureRows(rollup.failureCounts, rollup.failed) : [];
  if (rollup && rows.length === 0) return null;
  if (!rollup && pageFailures.length === 0) return null;
  return (
    <div className="batch-failures">
      <h3>Failure analysis</h3>
      {rollup ? (
        <table className="table batch-failure-table">
          <thead>
            <tr>
              <th>Cause</th>
              <th>Runs</th>
              <th>Share</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td>
                  <FailureCauseLabel
                    expId={expId}
                    label={row.label}
                    exampleRunId={failureExamples.get(row.key)}
                  />
                  {row.unclassified && (
                    <span className="muted"> · unclassified</span>
                  )}
                </td>
                <td className="mono">{row.count}</td>
                <td className="mono">{(row.share * 100).toFixed(0)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <ul className="batch-failure-list">
          {pageFailures.map((g) => (
            <li key={g.signature}>
              <span className="batch-failure-count">{g.count}×</span>
              <span className="batch-failure-sig">
                <FailureCauseLabel
                  expId={expId}
                  label={g.signature}
                  exampleRunId={g.exampleRunId}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The failure chip itself: a link into an example run's diagnosis panel
 *  when one is loaded, plain text otherwise (the bucket's runs may all be
 *  on unloaded pages). */
function FailureCauseLabel({
  expId,
  label,
  exampleRunId,
}: {
  expId: string;
  label: string;
  exampleRunId?: string;
}) {
  if (!exampleRunId) return <>{label}</>;
  return (
    <Link
      to={routes.run(expId, exampleRunId)}
      title="Open an affected run's failure diagnosis"
    >
      {label}
    </Link>
  );
}

export function GroupPanel({
  keys,
  groupKey,
  onGroupKey,
  groups,
  loadedCount,
}: {
  keys: string[];
  groupKey: string;
  onGroupKey: (key: string) => void;
  groups: ReturnType<typeof groupByParam>;
  loadedCount: number;
}) {
  return (
    <div className="batch-groups">
      <div className="batch-groups-head">
        <h3>Group by parameter</h3>
        <select
          value={groupKey}
          onChange={(e) => onGroupKey(e.target.value)}
          aria-label="Group runs by batch parameter"
        >
          <option value="">None</option>
          {keys.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        {groupKey && (
          <span className="muted">across {loadedCount} loaded runs</span>
        )}
      </div>
      {groupKey && (
        <table className="table batch-group-table">
          <thead>
            <tr>
              <th>{groupKey}</th>
              <th>Runs</th>
              <th>Finished</th>
              <th>Failed</th>
              <th>Median ΔE</th>
              <th>Best ΔE</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.value}>
                <td className="mono">{g.value}</td>
                <td className="mono">{g.count}</td>
                <td className="mono">{g.finished}</td>
                <td className="mono">{g.failed}</td>
                <td className="mono">{g.medianKcal == null ? "-" : g.medianKcal.toFixed(2)}</td>
                <td className="mono">{g.bestKcal == null ? "-" : g.bestKcal.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="batch-metric">
      <span className="batch-metric-label">{label}</span>
      <strong className="batch-metric-value">{value}</strong>
      {sub && <span className="batch-metric-sub muted">{sub}</span>}
    </div>
  );
}

function percentLabel(rate: number | undefined): string {
  return rate == null ? "—" : `${(rate * 100).toFixed(0)}%`;
}

function pct(value: number, total: number): number {
  return total > 0 ? (value / total) * 100 : 0;
}
