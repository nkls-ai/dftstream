import { Link } from "react-router-dom";
import { routes } from "../lib/routes";
import { prettyRunType } from "../lib/runTypeLabels";
import { useDataSource } from "../data/DataSource";
import { Chip } from "../components/KeywordChips";
import { runTypeKind } from "../components/keywordKinds";
import { RunStatusBadge } from "../components/RunStatusBadge";
import { RowMenu } from "../components/RowMenu";
import { useConfirm, usePrompt } from "../components/Confirm";
import type { ExperimentSummary } from "../data/types";
import { formatTimeSetting, useSettings } from "../lib/settings";
import { formatTimeAgo } from "../lib/time";
import { useGuardedAction } from "../hooks/useGuardedAction";

/** The card's run count. `summaryPending` means the backend has no rollup for
 *  this experiment yet (a pre-rollup experiment the backfill has not reached),
 *  so its runs are unknown rather than zero — saying "0 runs" there would be a
 *  claim about data we do not have. */
export function runCountLabel(exp: ExperimentSummary): string {
  if (exp.summaryPending) return "counting runs…";
  const plus = exp.runCountCapped ? "+" : "";
  return `${exp.runCount}${plus} run${exp.runCount === 1 ? "" : "s"}`;
}

/** Summary card for one experiment in the experiments grid. */
export function ExperimentCard({
  exp,
  onMarkRemoving,
  onUnmarkRemoving,
  onOptimisticRename,
  onClearOptimisticRename,
}: {
  exp: ExperimentSummary;
  onMarkRemoving: (id: string) => void;
  onUnmarkRemoving: (id: string) => void;
  onOptimisticRename: (id: string, name: string) => void;
  onClearOptimisticRename: (id: string) => void;
}) {
  const ds = useDataSource();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const guard = useGuardedAction();
  const [settings] = useSettings();
  const ago = formatTimeAgo(exp.lastActivity);

  const onRename = async () => {
    const next = await prompt({
      title: "Rename experiment",
      message: (
        <>
          Current name: <code>{exp.name}</code>
        </>
      ),
      defaultValue: exp.name,
      placeholder: "Experiment name",
      validate: (v) =>
        v.trim().length === 0 ? "Name cannot be empty." : null,
    });
    if (next == null) return;
    const trimmed = next.trim();
    if (trimmed === exp.name) return;
    onOptimisticRename(exp.id, trimmed);
    await guard(
      "rename experiment",
      async () => {
        await ds.renameExperiment(exp.id, trimmed);
        // Keep the overlay until the reactive query catches up — it will
        // strip the entry once data.name === trimmed.
        window.setTimeout(() => onClearOptimisticRename(exp.id), 1500);
      },
      { onError: () => onClearOptimisticRename(exp.id) },
    );
  };

  const onDelete = async () => {
    const ok = await confirm({
      title: `Delete experiment "${exp.name}"?`,
      tone: "danger",
      confirmLabel: "Delete",
      message: (
        <>
          This removes the experiment and all{" "}
          <strong>{runCountLabel(exp)}</strong> inside it - including every
          event, geometry, frequency, metric and artifact. This cannot be
          undone.
        </>
      ),
    });
    if (!ok) return;
    // Hide immediately for snappy feel; the action runs in the
    // background. If it fails we restore the card + show an alert.
    onMarkRemoving(exp.id);
    await guard("delete experiment", () => ds.removeExperiment(exp.id), {
      onError: () => onUnmarkRemoving(exp.id),
    });
    // On success: leave it in pendingRemove. The reactive query drops
    // the row a moment later, at which point the optimistic filter is
    // already a no-op.
  };

  return (
    <article className="exp-card">
      <div className="exp-card-head">
        <h2 className="exp-card-name">
          <Link to={routes.experiment(exp.id)} className="exp-card-link">
            {exp.name}
          </Link>
        </h2>
        <div className="exp-card-actions">
          <span className="exp-card-count">{runCountLabel(exp)}</span>
          <RowMenu
            ariaLabel={`actions for experiment ${exp.name}`}
            items={[
              { label: "Rename…", onClick: onRename },
              { label: "Delete…", tone: "danger", onClick: onDelete },
            ]}
          />
        </div>
      </div>

      <div className="exp-card-status">
        {exp.running > 0 && (
          <span className="exp-stat exp-stat-running">
            <span className="dot" /> {exp.running} running
          </span>
        )}
        {exp.finished > 0 && (
          <span className="exp-stat exp-stat-finished">
            <span className="dot" /> {exp.finished} finished
          </span>
        )}
        {exp.failed > 0 && (
          <span className="exp-stat exp-stat-failed">
            <span className="dot" /> {exp.failed} failed
          </span>
        )}
        {exp.runCount === 0 && !exp.summaryPending && (
          <span className="dim" style={{ fontSize: 12 }}>
            no runs yet
          </span>
        )}
      </div>

      <div className="chips" style={{ minHeight: 22 }}>
        {exp.topRunType && (
          <Chip kind={runTypeKind(exp.topRunType)} title="Most-used run type">
            {prettyRunType(exp.topRunType)}
          </Chip>
        )}
        {exp.topFunctional && (
          <Chip kind="func" title="Most-used functional">
            {exp.topFunctional}
          </Chip>
        )}
        {exp.topBasis && (
          <Chip kind="basis" title="Most-used basis">
            {exp.topBasis}
          </Chip>
        )}
      </div>

      <div className="exp-card-foot">
        <div
          className="dim exp-card-activity"
          title={formatTimeSetting(exp.lastActivity, settings.timeFormat)}
        >
          last activity {ago}
        </div>
        {exp.latestRunName && (
          <div className="mono exp-card-latest">
            {exp.latestStatus && (
              <RunStatusBadge status={exp.latestStatus} />
            )}
            <span className="exp-card-latest-name" title={exp.latestRunName}>
              {exp.latestRunName}
            </span>
          </div>
        )}
      </div>
    </article>
  );
}
