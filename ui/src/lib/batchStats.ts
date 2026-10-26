import type { Run, RunStatus } from "../data/types";
import { EH_TO_KCAL } from "./constants";
import { isActiveStatus, isTSSearchRun } from "./convergence";
import { gMinusElectronicEh } from "./thermo";

// The run fields the batch table, its filters and its exports actually read.
// A Pick rather than the full Run because the batch dashboard is fed by a
// backend PROJECTION (runs.listByBatchPaged) that deliberately omits the heavy
// columns — inputText above all. Every full Run satisfies this shape, so the
// experiment-level callers are unaffected.
export type BatchRunLike = Pick<
  Run,
  | "id"
  | "name"
  | "status"
  | "exitCode"
  | "errorClass"
  | "errorExcerpt"
  | "startedAt"
  | "finishedAt"
  | "wallclockSec"
  | "nprocs"
  | "ncores"
  | "lastEnergy"
  | "gibbsEh"
  | "gMinusEEh"
  | "converged"
  | "optMaxCycles"
  | "imaginaryModes"
  | "functional"
  | "basis"
  | "method"
  | "runTypes"
  | "batchParams"
  | "tags"
>;

// A run with its batch-relative energy attached (computed against the lowest
// finished energy in the batch). Drives both the table and the exports.
export type RankedRun = BatchRunLike & { relativeKcal?: number };

export type StatusFilter = "all" | RunStatus | "suspicious" | "notconverged";

export interface BatchStats {
  total: number;
  running: number;
  finished: number;
  failed: number;
  notConverged: number;
  suspicious: number;
}

/**
 * Tally over an in-memory run array.
 *
 * NOT the batch dashboard's source of truth: over a paginated batch this only
 * describes the runs that happen to be loaded. Batch-wide figures come from the
 * `batchProgress` rollup (see lib/batchProgress.ts). Kept for callers that
 * genuinely hold every run they care about.
 */
export function computeBatchStats(runs: BatchRunLike[]): BatchStats {
  return runs.reduce<BatchStats>(
    (acc, r) => {
      acc.total++;
      if (isActiveStatus(r.status)) acc.running++;
      if (r.status === "finished") acc.finished++;
      if (r.status === "failed") acc.failed++;
      if (r.converged === false) acc.notConverged++;
      if (isSuspicious(r)) acc.suspicious++;
      return acc;
    },
    { total: 0, running: 0, finished: 0, failed: 0, notConverged: 0, suspicious: 0 },
  );
}

/**
 * Attaches each run's energy relative to a reference and orders the list.
 *
 * `referenceEh` should be the batch-wide minimum from the rollup: with a
 * paginated table, referencing the loaded page's own minimum would make a run's
 * "relative E" shift as more pages load. It falls back to the minimum among the
 * given runs when no reference is available.
 */
export function rankRuns(runs: BatchRunLike[], referenceEh?: number): RankedRun[] {
  // Reference the lowest energy among runs that actually have one, so a single
  // missing-energy run can't poison the relative scale.
  const energies = runs
    .map((r) => r.lastEnergy)
    .filter((e): e is number => e != null && Number.isFinite(e));
  const minEnergy =
    referenceEh != null && Number.isFinite(referenceEh)
      ? referenceEh
      : energies.length > 0
        ? Math.min(...energies)
        : null;
  return runs
    .map((r) => ({
      ...r,
      relativeKcal:
        r.lastEnergy == null || minEnergy == null
          ? undefined
          : (r.lastEnergy - minEnergy) * EH_TO_KCAL,
    }))
    .sort((a, b) => {
      if (a.status !== b.status) return statusRank(a.status) - statusRank(b.status);
      return (a.relativeKcal ?? Number.POSITIVE_INFINITY) - (b.relativeKcal ?? Number.POSITIVE_INFINITY);
    });
}

function statusRank(status: RunStatus): number {
  return { failed: 0, running: 1, pending: 2, finished: 3 }[status];
}

export function matchesFilter(r: BatchRunLike, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "suspicious") return isSuspicious(r);
  if (filter === "notconverged") return r.converged === false;
  if (filter === "running") return isActiveStatus(r.status);
  return r.status === filter;
}

export function isSuspicious(r: BatchRunLike): boolean {
  if (r.status === "failed") return true;
  if (r.converged === false) return true;
  if (r.status === "finished" && r.lastEnergy == null) return true;
  // An imaginary mode is only a defect relative to what the job was looking
  // for. Every saddle-point search — OptTS AND the NEB-TS variants, whose
  // final phase is an OptTS — is *supposed* to produce one, so none of them
  // is flagged on the imaginary count.
  //
  // This predicate must be isTSSearchRun, not the narrower isOptTSRun: the
  // "Suspicious" tile is filled by the backend rollup, whose isSuspicious
  // (db/convex/lib/batchSummary.ts) uses isTSSearchRun. With isOptTSRun here,
  // a NEB-TS batch showed "Suspicious: 0" on the tile while every converged
  // TS row in the table below it was highlighted red — and the "suspicious"
  // filter selected all of them.
  if (r.imaginaryModes != null && r.imaginaryModes > 0 && !isTSSearchRun(r)) {
    return true;
  }
  return false;
}

// Group failed runs by a coarse signature so a 200-run batch collapses into a
// handful of actionable buckets ("12× exit code 1") instead of a wall.
//
// Page-scoped, and so only the FALLBACK for a batch whose rollup has not been
// built yet — the dashboard's failure table normally reads batchProgress
// .failureCounts, which covers every run. The bucket precedence (error class,
// else exit code) matches failureKeyOf in db/convex/lib/batchSummary.ts.
export function groupFailures(
  runs: BatchRunLike[],
): { signature: string; count: number; exampleRunId: string }[] {
  const groups = new Map<string, { count: number; exampleRunId: string }>();
  for (const r of runs) {
    if (r.status !== "failed") continue;
    const cls = r.errorClass?.trim();
    const sig = cls
      ? cls.replace(/_/g, " ")
      : r.exitCode != null
        ? `exit code ${r.exitCode}`
        : "failed (no exit code)";
    const g = groups.get(sig);
    // The first failed run seen is the bucket's example: it gives the
    // aggregate row somewhere concrete to navigate — that run's diagnosis.
    if (g) g.count += 1;
    else groups.set(sig, { count: 1, exampleRunId: r.id });
  }
  return [...groups.entries()]
    .map(([signature, g]) => ({ signature, ...g }))
    .sort((a, b) => b.count - a.count);
}

/**
 * One example failed run per rollup failure bucket, keyed exactly like the
 * rollup's failureCounts (failureKeyOf in db/convex/lib/batchSummary.ts:
 * error class if present, else `exit:<code>`, else "unknown"). Page-scoped
 * by nature — a bucket whose runs are all unloaded simply has no example.
 */
export function failureExamplesByKey(runs: BatchRunLike[]): Map<string, string> {
  const examples = new Map<string, string>();
  for (const r of runs) {
    if (r.status !== "failed") continue;
    const cls = r.errorClass?.trim();
    const key = cls
      ? cls
      : r.exitCode != null && Number.isFinite(r.exitCode)
        ? `exit:${r.exitCode}`
        : "unknown";
    if (!examples.has(key)) examples.set(key, r.id);
  }
  return examples;
}

// ---- Export ---------------------------------------------------------------

export const EXPORT_COLUMNS = [
  "name",
  "status",
  "method",
  "basis",
  "energy_eh",
  "relative_kcal",
  "gibbs_eh",
  "g_minus_e_eh",
  "converged",
  "imaginary_modes",
  "wallclock_s",
  "params",
] as const;

function exportRow(r: RankedRun): string[] {
  const gMinusE = gMinusElectronicEh(r);
  return [
    r.name ?? r.id,
    r.status,
    r.functional ?? r.method ?? "",
    r.basis ?? "",
    r.lastEnergy != null ? String(r.lastEnergy) : "",
    r.relativeKcal != null ? r.relativeKcal.toFixed(3) : "",
    r.gibbsEh != null ? r.gibbsEh.toFixed(8) : "",
    gMinusE != null ? gMinusE.toFixed(8) : "",
    r.converged == null ? "" : String(r.converged),
    r.imaginaryModes != null ? String(r.imaginaryModes) : "",
    r.wallclockSec != null ? String(r.wallclockSec) : "",
    Object.entries(r.batchParams ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("; "),
  ];
}

export function csvCell(value: string): string {
  // RFC-4180: quote when the cell contains a comma, quote, or newline; double
  // up embedded quotes.
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCSV(runs: RankedRun[]): string {
  const lines = [EXPORT_COLUMNS.join(",")];
  for (const r of runs) lines.push(exportRow(r).map(csvCell).join(","));
  return lines.join("\n");
}

export function toMarkdown(batchName: string, runs: RankedRun[]): string {
  const header = `| ${EXPORT_COLUMNS.join(" | ")} |`;
  const sep = `| ${EXPORT_COLUMNS.map(() => "---").join(" | ")} |`;
  const rows = runs.map(
    (r) => `| ${exportRow(r).map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`,
  );
  return [`# Batch: ${batchName}`, "", header, sep, ...rows, ""].join("\n");
}
