// Pure presentation logic for the experiment queue section, kept out of the
// component so it is testable without rendering.

import type { QueuedJob, QueuedJobState } from "../data/DataSource";

// Once a queued job is linked to a tracked run, the run row tells the story
// (status, energies, logs) and the queue row would repeat it — so linked
// jobs collapse out of the queue section the moment their run exists in the
// loaded run list. A linked job whose run is NOT loaded (deleted run, or a
// truncated run list) stays visible rather than silently disappearing.
// Terminal unlinked jobs stay too: "cancelled" / "failed before ORCA
// started" is exactly what the section exists to show.
export function visibleQueuedJobs(
  jobs: QueuedJob[],
  loadedRunIds: ReadonlySet<string>,
): QueuedJob[] {
  return jobs
    .filter((j) => !(j.linkedRunId && loadedRunIds.has(j.linkedRunId)))
    .sort((a, b) => b.submittedAt - a.submittedAt);
}

// State chip class + label. Reuses the run-status `.badge` palette where the
// meanings coincide (completed renders like a finished run); cancelled and
// unknown have their own badge variants in index.css.
export function queueStateChip(state: QueuedJobState): {
  className: string;
  label: string;
} {
  const css = state === "completed" ? "finished" : state;
  return { className: `badge ${css}`, label: state.toUpperCase() };
}

// A cancel button makes sense only while the scheduler still holds the job
// and nobody has asked yet.
export function canRequestCancel(job: QueuedJob): boolean {
  if (job.cancelRequested) return false;
  return (
    job.state === "pending" || job.state === "running" || job.state === "unknown"
  );
}

// Coarse "how long ago", matching what squeue users expect to scan.
export function queueAgeLabel(submittedAt: number, now: number): string {
  const ms = Math.max(0, now - submittedAt);
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ${min % 60}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ago`;
}

// Display name: input file, with the array shape when the job is an array.
export function queueJobLabel(job: QueuedJob): string {
  if (job.arraySpec) return `${job.inputBasename} (array ${job.arraySpec})`;
  return job.inputBasename;
}
