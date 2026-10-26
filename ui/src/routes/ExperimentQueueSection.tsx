import { useMemo, useState } from "react";
import { useDataSource } from "../data/DataSource";
import type { QueuedJob } from "../data/DataSource";
import {
  canRequestCancel,
  queueAgeLabel,
  queueJobLabel,
  queueStateChip,
  visibleQueuedJobs,
} from "./queueView";
import { userErrorMessage } from "../lib/errorReporting";

// Scheduler-queue section of the experiment view: jobs `dftstream submit`
// handed to the cluster, visible BEFORE any tracked run exists for them.
// Jobs collapse into their run row once ORCA starts (see visibleQueuedJobs).
//
// Cancellation here is a REQUEST: the backend can never reach the cluster,
// so the button only sets a flag that `dftstream queue watch` on a login
// node acts on at its next poll. The copy says so.

export function ExperimentQueueSection({
  expId,
  loadedRunIds,
}: {
  expId: string;
  loadedRunIds: ReadonlySet<string>;
}) {
  const ds = useDataSource();
  const jobs = ds.useQueuedJobsByExperiment(expId);
  const visible = useMemo(
    () => visibleQueuedJobs(jobs.data ?? [], loadedRunIds),
    [jobs.data, loadedRunIds],
  );
  if (jobs.loading || visible.length === 0) return null;
  return (
    <QueueTable
      jobs={visible}
      requestCancel={(id) => ds.requestCancelQueuedJob(id)}
    />
  );
}

// Presentational half, injectable for tests.
export function QueueTable({
  jobs,
  requestCancel,
}: {
  jobs: QueuedJob[];
  requestCancel: (id: string) => Promise<void>;
}) {
  // Ids with a cancel request in flight or applied optimistically, and the
  // last cancel failure to surface (per CLAUDE.md no mutation failure may
  // vanish into the void).
  const [pendingCancels, setPendingCancels] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [cancelError, setCancelError] = useState<string | null>(null);
  const now = Date.now();

  const onCancel = (id: string) => {
    setCancelError(null);
    setPendingCancels((prev) => new Set(prev).add(id));
    requestCancel(id).catch((err: unknown) => {
      setPendingCancels((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setCancelError(userErrorMessage(err, "cancel the queued job"));
    });
  };

  return (
    <div className="queue-section">
      <h2 className="queue-section-title">Scheduler queue</h2>
      <div className="subtitle muted">
        Jobs submitted to the cluster that have not reported a run yet. States
        update when <span className="mono">dftstream queue watch</span> polls
        on a login node.
      </div>
      {cancelError && (
        <div className="queue-error" role="alert">
          Cancel request failed: {cancelError}
        </div>
      )}
      <table className="table queue-table">
        <thead>
          <tr>
            <th>Job</th>
            <th>State</th>
            <th>Cluster</th>
            <th>Scheduler ID</th>
            <th>Submitted</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => {
            const chip = queueStateChip(job.state);
            const requested = job.cancelRequested || pendingCancels.has(job.id);
            return (
              <tr key={job.id}>
                <td className="mono">{queueJobLabel(job)}</td>
                <td>
                  <span className={chip.className}>{chip.label}</span>
                </td>
                <td>{job.cluster}</td>
                <td className="mono">{job.schedulerJobId}</td>
                <td>{queueAgeLabel(job.submittedAt, now)}</td>
                <td>
                  {requested ? (
                    <span
                      className="muted"
                      title="scancel runs when the login-node watcher (dftstream queue watch) next polls"
                    >
                      cancel requested
                    </span>
                  ) : canRequestCancel(job) ? (
                    <button
                      type="button"
                      className="button button-danger"
                      title="Takes effect when the login-node watcher next polls"
                      onClick={() => onCancel(job.id)}
                    >
                      Cancel
                    </button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
