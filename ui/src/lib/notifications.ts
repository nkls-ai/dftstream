// Pure logic behind the run-completion notification feed: snapshotting the
// set of running runs and diffing successive snapshots to find runs that
// just finished. React-free so it can be unit tested.

import type { Run, RunStatus } from "../data/types";
import { isConvergenceGated } from "./convergence";

/** The terminal statuses a completion notification can carry. */
export type CompletionStatus = Extract<RunStatus, "finished" | "failed">;

export interface RunSnapshot {
  id: string;
  name: string;
  experimentId: string;
}

export interface RunNotification {
  id: string;
  runId: string;
  runName: string;
  experimentId: string;
  status: CompletionStatus;
  converged?: boolean;
  imaginaryModes?: number;
  ts: number;
}

export const MAX_NOTIFICATIONS = 20;

/** Index the currently running runs by id, keeping just what a toast needs. */
export function snapshotRunning(
  runs: Pick<Run, "id" | "name" | "experimentId">[],
): Map<string, RunSnapshot> {
  const map = new Map<string, RunSnapshot>();
  for (const r of runs) {
    map.set(r.id, { id: r.id, name: r.name ?? r.id, experimentId: r.experimentId });
  }
  return map;
}

/** Runs present in the previous snapshot but gone from the current one. */
export function diffDisappeared(
  prev: Map<string, RunSnapshot>,
  current: Map<string, RunSnapshot>,
): RunSnapshot[] {
  const out: RunSnapshot[] = [];
  for (const [id, snap] of prev) {
    if (!current.has(id)) out.push(snap);
  }
  return out;
}

/** Build the notification for a run that left the running set. */
export function completionNotification(
  snap: RunSnapshot,
  resolved: Pick<Run, "status" | "converged" | "imaginaryModes" | "runTypes"> | null,
  now: number = Date.now(),
): RunNotification {
  return {
    id: `${snap.id}-${now}`,
    runId: snap.id,
    runName: snap.name,
    experimentId: snap.experimentId,
    status: resolved?.status === "failed" ? "failed" : "finished",
    // Only carried for jobs that actually have a convergence criterion. A
    // single point, a scan or a plain Freq has no geometry to converge, and
    // the wrapper has historically written `converged: false` on them; the
    // toast then announced "SP-water finished (not converged)", which is not a
    // fact about the calculation at all.
    converged:
      resolved && isConvergenceGated(resolved) ? resolved.converged : undefined,
    imaginaryModes: resolved?.imaginaryModes,
    ts: now,
  };
}
