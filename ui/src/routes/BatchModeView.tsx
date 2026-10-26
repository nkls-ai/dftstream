import { routes } from "../lib/routes";
import { Link } from "react-router-dom";
import { RunStatusBadge } from "../components/RunStatusBadge";
import { RowMenu } from "../components/RowMenu";
import { useConfirm, usePrompt } from "../components/Confirm";
import { SkeletonTable } from "../components/Skeleton";
import { useDataSource } from "../data/DataSource";
import type { Batch } from "../data/types";
import { downloadText } from "../lib/download";
import { runDurationLabel } from "../lib/time";
import { batchConvergence } from "../lib/convergence";
import {
  isSuspicious,
  toCSV,
  toMarkdown,
  type BatchRunLike,
  type RankedRun,
  type StatusFilter,
} from "../lib/batchStats";
import {
  EnergyPanel,
  FailurePanel,
  GroupPanel,
  HeadlinePanel,
  ProgressBar,
  QualityPanel,
  ThroughputPanel,
} from "./BatchMetricPanels";
import { useGuardedAction } from "../hooks/useGuardedAction";
import { RUN_PAGE_SIZE, useBatchDashboardModel } from "./useBatchDashboardModel";


export function BatchModeView({
  expId,
  batches,
  selectedBatchId,
  onSelectBatch,
}: {
  expId: string;
  batches: Batch[];
  /** Ignored. The dashboard subscribes to the batch itself (rollup + paginated
   *  runs) because the experiment-level run list this used to be fed from is
   *  capped, and tallying a capped array reports a large batch's numbers
   *  wrongly. Kept in the props so the caller compiles unchanged. */
  runs?: BatchRunLike[];
  selectedBatchId: string | null;
  onSelectBatch: (batchId: string) => void;
}) {
  const ds = useDataSource();
  const prompt = usePrompt();
  const confirm = useConfirm();
  const guard = useGuardedAction();
  const selectedBatch = batches.find((b) => b.id === selectedBatchId) ?? batches[0];

  async function onRename(batch: Batch) {
    const name = await prompt({
      title: "Rename batch",
      defaultValue: batch.name,
      confirmLabel: "Rename",
      validate: (v) => (v.trim().length === 0 ? "Name cannot be empty." : null),
    });
    if (name == null || name.trim() === batch.name) return;
    await guard("rename batch", () => ds.renameBatch(batch.id, name.trim()));
  }

  async function onDelete(batch: Batch) {
    const ok = await confirm({
      title: `Delete batch "${batch.name}"?`,
      message:
        "This only removes the batch grouping. The runs themselves stay in the experiment. A batch that still contains runs cannot be deleted — detach or delete its runs first.",
      tone: "danger",
      confirmLabel: "Delete batch",
    });
    if (!ok) return;
    await guard("delete batch", () => ds.removeBatch(batch.id));
  }

  if (batches.length === 0) {
    return (
      <div className="empty-state">
        No batches yet. Create one, then attach jobs with <code>dftstream run --batch &lt;name&gt; …</code> or <code>dftstream import-batch --batch &lt;name&gt; …</code>.
      </div>
    );
  }

  return (
    <div className="batch-layout">
      <aside className="batch-sidebar" aria-label="Batches">
        {batches.map((batch) => (
          <div
            key={batch.id}
            className={"batch-pill" + (batch.id === selectedBatch?.id ? " active" : "")}
          >
            <button
              type="button"
              className="batch-pill-select"
              onClick={() => onSelectBatch(batch.id)}
            >
              <span>{batch.name}</span>
              <span className="mono muted">{batch.artifactLevel ?? "io"}</span>
            </button>
            <RowMenu
              ariaLabel={`actions for batch ${batch.name}`}
              items={[
                { label: "Rename", onClick: () => void onRename(batch) },
                { label: "Delete", tone: "danger", onClick: () => void onDelete(batch) },
              ]}
            />
          </div>
        ))}
      </aside>
      {selectedBatch ? (
        <BatchDashboard key={selectedBatch.id} expId={expId} batch={selectedBatch} />
      ) : null}
    </div>
  );
}

function BatchDashboard({ expId, batch }: { expId: string; batch: Batch }) {
  const {
    progress,
    runs,
    filter,
    setFilter,
    groupKey,
    setGroupKey,
    loaded,
    rollup,
    metrics,
    ranked,
    filtered,
    spread,
    outliers,
    keys,
    groups,
    moleculeKey,
    moleculeGroups,
    pageFailures,
    failureExamples,
    tiles,
  } = useBatchDashboardModel(batch);

  return (
    <section className="batch-dashboard">
      <div className="batch-hero">
        <div>
          <div className="eyebrow">Batch Mode</div>
          <h2>{batch.name}</h2>
          <p>
            Individual calculations stay as normal runs. This view summarizes the batch so the next suspicious or promising result is obvious.
          </p>
        </div>
        <div className="batch-artifact-card">
          <span className="muted">Default artifacts</span>
          <strong>{batch.artifactLevel ?? "io"}</strong>
          <span className="muted">input/output first</span>
        </div>
      </div>

      {progress.loading || runs.loading ? (
        <SkeletonTable rows={5} cols={6} />
      ) : (
        <>
          {rollup === null && (
            <div className="batch-notice">
              This batch has no progress rollup yet — the backfill runs in the
              background. The figures below cover only the{" "}
              <strong>{loaded.length}</strong> loaded run
              {loaded.length === 1 ? "" : "s"}, not the whole batch.
            </div>
          )}

          {metrics && <ProgressBar metrics={metrics} />}

          <div className="batch-stat-grid">
            <FilterCard label="Runs" value={tiles.total} active={filter === "all"} onClick={() => setFilter("all")} />
            <FilterCard label="Running" value={tiles.inFlight} tone="running" active={filter === "running"} onClick={() => setFilter("running")} />
            <FilterCard label="Finished" value={tiles.finished} tone="ok" active={filter === "finished"} onClick={() => setFilter("finished")} />
            <FilterCard label="Failed" value={tiles.failed} tone="bad" active={filter === "failed"} onClick={() => setFilter("failed")} />
            {/* One tile, not two: "suspicious" already includes every
                not-converged run, so showing both invited the reading that
                they were disjoint counts. */}
            <FilterCard label="Needs a look" value={tiles.suspicious} tone={tiles.suspicious > 0 ? "warn" : undefined} active={filter === "suspicious"} onClick={() => setFilter("suspicious")} />
          </div>

          {tiles.total === 0 ? (
            <div className="empty-state">No runs are attached to this batch yet.</div>
          ) : (
            <>
              {metrics && (
                <HeadlinePanel
                  metrics={metrics}
                  molecules={moleculeGroups?.length}
                  moleculeKey={moleculeKey}
                  moleculeScope={ranked.length}
                />
              )}

              {keys.length > 0 && (
                <GroupPanel
                  keys={keys}
                  groupKey={groupKey}
                  onGroupKey={setGroupKey}
                  groups={groups}
                  loadedCount={ranked.length}
                />
              )}

              <FailurePanel
                expId={expId}
                rollup={rollup}
                failureExamples={failureExamples}
                pageFailures={pageFailures}
              />

              {/* Everything below is real but secondary. It stays one click
                  away rather than competing with the numbers above: the
                  common question is "how far along, how fast, what broke",
                  not "what is the interquartile range of the energies". */}
              {metrics && (
                <details className="batch-more">
                  <summary>More statistics</summary>
                  <ThroughputPanel metrics={metrics} />
                  <QualityPanel metrics={metrics} />
                  <EnergyPanel
                    metrics={metrics}
                    medianKcal={spread.medianKcal}
                    outlierCount={spread.outlierIds.length}
                    pageCount={spread.count}
                  />
                </details>
              )}

              <div className="batch-toolbar">
                <span className="muted">
                  {filtered.length === ranked.length
                    ? `${ranked.length} run${ranked.length === 1 ? "" : "s"} loaded${
                        metrics && metrics.total > ranked.length ? ` of ${metrics.total}` : ""
                      }`
                    : `${filtered.length} of ${ranked.length} loaded runs · ${filterLabel(filter)}`}
                </span>
                <div className="batch-export">
                  <button
                    type="button"
                    className="dl-btn"
                    disabled={filtered.length === 0}
                    onClick={() => downloadText(`${batch.name}-batch.csv`, toCSV(filtered))}
                  >
                    Export CSV
                  </button>
                  <button
                    type="button"
                    className="dl-btn"
                    disabled={filtered.length === 0}
                    onClick={() => downloadText(`${batch.name}-batch.md`, toMarkdown(batch.name, filtered))}
                  >
                    Export Markdown
                  </button>
                </div>
              </div>

              {filtered.length === 0 ? (
                <div className="empty-state">No runs match this filter.</div>
              ) : (
                <div className="batch-table-scroll">
                <table className="table batch-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Status</th>
                      <th>Method</th>
                      <th>ΔE (kcal/mol)</th>
                      <th>Convergence</th>
                      <th>Imag</th>
                      <th>Duration</th>
                      <th>Parameters</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((r) => (
                      <tr key={r.id} className={isSuspicious(r) ? "batch-suspicious-row" : undefined}>
                        <td className="nowrap-cell">
                          <Link to={routes.run(expId, r.id)}>{r.name ?? r.id.slice(0, 10)}</Link>
                        </td>
                        <td className="nowrap-cell"><RunStatusBadge status={r.status} /></td>
                        {/* Functional over basis: two fixed lines, never three. */}
                        <td className="mono nowrap-cell">
                          {r.functional ?? r.method ?? "-"}
                          {r.basis && <div className="muted">{r.basis}</div>}
                        </td>
                        <td className="mono nowrap-cell">
                          {r.relativeKcal == null ? "-" : r.relativeKcal.toFixed(2)}
                          {outliers.has(r.id) && (
                            <span className="batch-outlier-flag" title="Above the upper Tukey fence of the loaded runs">outlier</span>
                          )}
                        </td>
                        <td><ConvergenceCell run={r} /></td>
                        <td className="mono">{r.imaginaryModes ?? "-"}</td>
                        <td className="mono muted nowrap-cell">{runDurationLabel(r)}</td>
                        <td><ParamPills params={r.batchParams} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              )}

              {runs.canLoadMore && (
                <div className="batch-loadmore">
                  <button
                    type="button"
                    className="dl-btn"
                    disabled={runs.loadingMore}
                    onClick={runs.loadMore}
                  >
                    {runs.loadingMore ? "Loading…" : `Load ${RUN_PAGE_SIZE} more`}
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

function FilterCard({
  label,
  value,
  tone,
  active,
  onClick,
}: {
  label: string;
  value: number;
  tone?: "running" | "ok" | "bad" | "warn";
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={"batch-stat-card" + (tone ? ` ${tone}` : "") + (active ? " active" : "")}
      onClick={onClick}
      aria-pressed={active}
    >
      <span>{label}</span>
      <strong>{value}</strong>
    </button>
  );
}

function ParamPills({ params }: { params?: Record<string, string | number | boolean> }) {
  const entries = Object.entries(params ?? {});
  if (entries.length === 0) return <span className="muted">-</span>;
  return (
    <div className="batch-param-pills">
      {entries.map(([key, value]) => (
        <span key={key} className="batch-param-pill">
          <span>{key}</span>=<strong>{String(value)}</strong>
        </span>
      ))}
    </div>
  );
}

function filterLabel(filter: StatusFilter): string {
  if (filter === "all") return "all";
  if (filter === "notconverged") return "not converged";
  return filter;
}

function ConvergenceCell({ run }: { run: RankedRun }) {
  const badge = batchConvergence(run);
  if (!badge) return <span className="muted">unknown</span>;
  return <span className={`conv-badge conv-${badge.tone}`}>{badge.label}</span>;
}
