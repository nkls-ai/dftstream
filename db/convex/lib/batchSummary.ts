import type { Doc, Id } from "../_generated/dataModel";
import { ERROR_CLASS, RUN_STATUS, type RunStatus } from "../schema";

// Pure tally logic behind the `batchProgress` rollup. The db reads/writes stay
// in runs.ts / lib/batchProgressWriter.ts; everything here is a plain function
// over plain objects, so it is unit-testable without convex-test (see
// batchSummary.test.ts) — same split as lib/experimentSummary.ts.
//
// The rollup is maintained as a DIFF: every mutation that touches a run
// computes the run's contribution before and after the write and applies
// (after - before). That makes the counters idempotent by construction — a
// repeated `updateStatus` with identical values produces a zero delta — and
// keeps re-imports, restarts and status-less result patches consistent without
// any special-casing per call site.
//
// A batch's rollup is stored as SEVERAL rows that sum to the truth, not one
// row that is the truth. A run write appends its delta and never reads the
// existing rows, because read-modify-write on one hot document does not
// survive concurrency: with a single row, two clients writing runs of the same
// batch back-to-back exhaust Convex's OCC retries and `runs.create` starts
// failing outright (measured — see .ai_scripts/seed-batch-load.ts). Appended
// deltas conflict with nothing. A compaction pass folds the oldest rows back
// into one so the read side stays cheap; see lib/batchProgressWriter.ts.
// Consequently DELTA ROWS MAY HOLD NEGATIVE COUNTS — only the merged sum is
// meaningful, and only mergeProgress clamps.

// --- what a run contributes ---------------------------------------------------

/** The run fields the rollup depends on. A Pick (not the full Doc) so the
 *  tests stay honest about what the tally actually reads. */
export type ProgressRun = Pick<
  Doc<"runs">,
  | "status"
  | "exitCode"
  | "errorClass"
  | "converged"
  | "optMaxCycles"
  | "imaginaryModes"
  | "gibbsEh"
  | "lastEnergy"
  | "wallclockSec"
  | "nprocs"
  | "ncores"
  | "startedAt"
  | "finishedAt"
  | "runTypes"
>;

/** Additive counters — every one of these is maintained by summing deltas. */
export const COUNTER_KEYS = [
  "total",
  "pending",
  "running",
  "finished",
  "failed",
  "converged",
  "notConverged",
  "optMaxCycles",
  "withImaginary",
  "missingThermo",
  "suspicious",
  "wallclockSumSec",
  "wallclockSumSqSec",
  "coreSecondsSum",
  "energySumEh",
  "energyCount",
] as const;

export type CounterKey = (typeof COUNTER_KEYS)[number];
export type Counters = Record<CounterKey, number>;

// Every counter except the energy sum is a count or a non-negative physical
// quantity, so the merged total is clamped at zero. The energy sum is a sum of
// (negative) Hartree totals and must stay signed.
const SIGNED_COUNTER_KEYS: ReadonlySet<CounterKey> = new Set<CounterKey>([
  "energySumEh",
]);

/** One run's contribution to a batch's rollup. The non-additive parts
 *  (extremes and the failure bucket) are carried alongside the counters. */
export interface RunContribution {
  counters: Counters;
  /** failureCounts key this run occupies while it is in the failed state. */
  failureKey?: string;
  startedAt?: number;
  finishedAt?: number;
  /** lastEnergy of a finished run, for the batch-wide minimum. */
  energyEh?: number;
}

/** Prefix for a failure bucket keyed by process exit code, used when the
 *  wrapper did not classify the failure (older wrappers, or a class the
 *  classifier has no rule for). Distinct from any ERROR_CLASS member. */
export const EXIT_CODE_KEY_PREFIX = "exit:";

export function zeroCounters(): Counters {
  const c = {} as Counters;
  for (const k of COUNTER_KEYS) c[k] = 0;
  return c;
}

/** Mirrors ui/src/lib/convergence.ts TS_SEARCH_RUN_TYPES. Duplicated rather
 *  than shared because the db and ui packages have no common module; compared
 *  case-insensitively since run types reach us in whatever case ORCA's input
 *  used. */
const TS_SEARCH_RUN_TYPES = ["OPTTS", "NEB-TS", "ZOOM-NEB-TS"] as const;

function isTSSearchRun(r: Pick<ProgressRun, "runTypes">): boolean {
  return (
    r.runTypes?.some((t) =>
      (TS_SEARCH_RUN_TYPES as readonly string[]).includes(t.toUpperCase()),
    ) ?? false
  );
}

function isTerminal(status: RunStatus): boolean {
  return status === RUN_STATUS.FINISHED || status === RUN_STATUS.FAILED;
}

/** Mirrors ui/src/lib/batchStats.ts isSuspicious — the "look at this one"
 *  heuristic, evaluated server-side so it covers the whole batch and not just
 *  the runs a page happened to load. */
function isSuspicious(r: ProgressRun): boolean {
  if (r.status === RUN_STATUS.FAILED) return true;
  if (r.converged === false) return true;
  if (r.status === RUN_STATUS.FINISHED && r.lastEnergy == null) return true;
  if (r.imaginaryModes != null && r.imaginaryModes > 0 && !isTSSearchRun(r)) {
    return true;
  }
  return false;
}

/** Seconds of wallclock to attribute to a run. ORCA's own "TOTAL RUN TIME" is
 *  authoritative; imported runs often lack it, so fall back to the tracked
 *  interval. A run with neither contributes 0 — it is then invisible to the
 *  duration distribution but still counted as finished, which biases the mean
 *  low rather than inventing a duration. */
export function runWallclockSec(
  r: Pick<ProgressRun, "wallclockSec" | "startedAt" | "finishedAt">,
): number {
  if (r.wallclockSec != null && Number.isFinite(r.wallclockSec) && r.wallclockSec > 0) {
    return r.wallclockSec;
  }
  if (r.finishedAt != null && Number.isFinite(r.finishedAt)) {
    const sec = (r.finishedAt - r.startedAt) / 1000;
    if (Number.isFinite(sec) && sec > 0) return sec;
  }
  return 0;
}

/** Cores the run occupied. nprocs (MPI ranks ORCA actually started) beats the
 *  host's core count; 1 when neither was recorded. */
function runCores(r: Pick<ProgressRun, "nprocs" | "ncores">): number {
  for (const n of [r.nprocs, r.ncores]) {
    if (n != null && Number.isFinite(n) && n >= 1) return n;
  }
  return 1;
}

/** The failureCounts bucket for a failed run. Prefers the wrapper's error
 *  class; falls back to the exit code, then to "unknown", so the failure table
 *  is never empty just because the classifier had nothing to say. */
export function failureKeyOf(
  r: Pick<ProgressRun, "errorClass" | "exitCode">,
): string {
  const cls = r.errorClass?.trim();
  if (cls) return cls;
  if (r.exitCode != null && Number.isFinite(r.exitCode)) {
    return `${EXIT_CODE_KEY_PREFIX}${r.exitCode}`;
  }
  return ERROR_CLASS.UNKNOWN;
}

/**
 * runContribution maps one run to the counters it occupies right now.
 *
 * Every call site is a diff of two of these, which yields this transition
 * table without a single per-case branch:
 *
 *   before → after        counters moved
 *   ────────────────────  ─────────────────────────────────────────────────
 *   (none) → pending      total+1, pending+1               (runs.create)
 *   pending → running     pending-1, running+1
 *   running → finished    running-1, finished+1, + quality/timing/energy
 *   running → failed      running-1, failed+1, + coreSeconds, failureCounts+1
 *   failed → running      failed-1, running+1, failureCounts-1   (a restart)
 *   failed → failed'      failure bucket moves (a reclassified error)
 *   X → X                 nothing (a replayed or status-less result patch),
 *                         except the result fields that actually changed
 *   any → (none)          the whole contribution, negated  (run deleted)
 *   no batchId            nothing, in either direction
 *
 * Denominators worth knowing, because they are not all the same:
 *  - wallclockSumSec / wallclockSumSqSec cover FINISHED runs only. A failed
 *    run usually dies early, and mixing those durations in would drag the ETA
 *    of the remaining work down. Their denominator is therefore `finished`.
 *  - coreSecondsSum covers every TERMINAL run: a crashed job still burned the
 *    allocation, so it belongs in the core-hours bill.
 *  - the quality tallies cover terminal runs; missingThermo and the energy
 *    aggregates cover finished runs (a failed run has no thermo to miss).
 */
export function runContribution(r: ProgressRun): RunContribution {
  const counters = zeroCounters();
  counters.total = 1;
  counters[statusKey(r.status)] = 1;

  const terminal = isTerminal(r.status);
  const finished = r.status === RUN_STATUS.FINISHED;

  if (terminal) {
    if (r.converged === true) counters.converged = 1;
    if (r.converged === false) counters.notConverged = 1;
    if (r.optMaxCycles === true) counters.optMaxCycles = 1;
    if (r.imaginaryModes != null && r.imaginaryModes > 0) counters.withImaginary = 1;
    if (isSuspicious(r)) counters.suspicious = 1;
    counters.coreSecondsSum = runWallclockSec(r) * runCores(r);
  }

  let energyEh: number | undefined;
  if (finished) {
    if (r.gibbsEh == null) counters.missingThermo = 1;
    if (r.lastEnergy != null && Number.isFinite(r.lastEnergy)) {
      energyEh = r.lastEnergy;
      counters.energySumEh = r.lastEnergy;
      counters.energyCount = 1;
    }
    const wall = runWallclockSec(r);
    counters.wallclockSumSec = wall;
    counters.wallclockSumSqSec = wall * wall;
  }

  return {
    counters,
    failureKey: r.status === RUN_STATUS.FAILED ? failureKeyOf(r) : undefined,
    startedAt: Number.isFinite(r.startedAt) ? r.startedAt : undefined,
    finishedAt: terminal && r.finishedAt != null ? r.finishedAt : undefined,
    energyEh,
  };
}

/**
 * isZeroContributionChange is true when a run write leaves the run's
 * contribution exactly as it was — the common case for the replayed and
 * result-only patches the wrapper sends. The delta row it would append carries
 * zero counters, and its extremes (firstStartedAt / lastFinishedAt /
 * minEnergyEh) are the very values the earlier write already folded in, so the
 * row changes nothing and would only add read cost. The batch twin of
 * experimentSummary.isZeroExperimentDelta.
 */
export function isZeroContributionChange(
  before: RunContribution,
  after: RunContribution,
): boolean {
  for (const key of COUNTER_KEYS) {
    if (!Object.is(before.counters[key], after.counters[key])) return false;
  }
  return (
    before.failureKey === after.failureKey &&
    Object.is(before.startedAt, after.startedAt) &&
    Object.is(before.finishedAt, after.finishedAt) &&
    Object.is(before.energyEh, after.energyEh)
  );
}

/** The status counter a run occupies. Exhaustive over RUN_STATUS. */
function statusKey(status: RunStatus): CounterKey {
  switch (status) {
    case RUN_STATUS.PENDING:
      return "pending";
    case RUN_STATUS.RUNNING:
      return "running";
    case RUN_STATUS.FINISHED:
      return "finished";
    case RUN_STATUS.FAILED:
      return "failed";
  }
}

// --- the rollup document ------------------------------------------------------

/** The stored shape of a batchProgress row (schema.batchProgressFields), minus
 *  Convex's system fields. */
export type ProgressValues = Counters & {
  batchId: Id<"batches">;
  experimentId: Id<"experiments">;
  firstStartedAt?: number;
  lastFinishedAt?: number;
  minEnergyEh?: number;
  failureCounts: Record<string, number>;
  updatedAt: number;
};

export function emptyProgress(
  batchId: Id<"batches">,
  experimentId: Id<"experiments">,
  now: number,
): ProgressValues {
  return {
    ...zeroCounters(),
    batchId,
    experimentId,
    failureCounts: {},
    updatedAt: now,
  };
}

/**
 * applyContribution folds (after - before) into a rollup and returns the new
 * value object. `before`/`after` are null for a run entering or leaving the
 * batch; passing the same contribution as both is a no-op, which is what makes
 * a replayed mutation harmless.
 *
 * Applied to a zeroed row it produces a standalone DELTA row, whose counts may
 * legitimately be negative (a run leaving the batch). Nothing is clamped here;
 * see mergeProgress.
 *
 * Note on the extremes (firstStartedAt / lastFinishedAt / minEnergyEh): a
 * min/max cannot be un-done by a diff, so they are monotone — deleting the
 * run that held the minimum energy leaves the old bound in place. That is a
 * conservative bound, never a wrong count, and the backfill migration
 * recomputes all three exactly.
 */
export function applyContribution(
  prev: ProgressValues,
  before: RunContribution | null,
  after: RunContribution | null,
  now: number,
): ProgressValues {
  const next: ProgressValues = { ...prev, failureCounts: { ...prev.failureCounts } };
  for (const key of COUNTER_KEYS) {
    next[key] =
      prev[key] + (after?.counters[key] ?? 0) - (before?.counters[key] ?? 0);
  }

  if (before?.failureKey) bumpFailure(next.failureCounts, before.failureKey, -1);
  if (after?.failureKey) bumpFailure(next.failureCounts, after.failureKey, 1);

  if (after?.startedAt != null) {
    next.firstStartedAt =
      prev.firstStartedAt == null
        ? after.startedAt
        : Math.min(prev.firstStartedAt, after.startedAt);
  }
  if (after?.finishedAt != null) {
    next.lastFinishedAt =
      prev.lastFinishedAt == null
        ? after.finishedAt
        : Math.max(prev.lastFinishedAt, after.finishedAt);
  }
  if (after?.energyEh != null) {
    next.minEnergyEh =
      prev.minEnergyEh == null
        ? after.energyEh
        : Math.min(prev.minEnergyEh, after.energyEh);
  }

  next.updatedAt = now;
  return next;
}

/** bumpFailure keeps a zero entry out of the record but preserves negative
 *  ones: in a delta row "-1 out_of_memory" is the un-count of a restarted
 *  failure, and dropping it would leave the merged total too high. */
function bumpFailure(counts: Record<string, number>, key: string, by: number) {
  const value = (counts[key] ?? 0) + by;
  if (value === 0) delete counts[key];
  else counts[key] = value;
}

/**
 * sumProgress adds delta rows together WITHOUT clamping. Used by compaction,
 * which folds a subset of a batch's rows: a subset's running total can
 * legitimately be negative (the delta removing a run may be compacted before
 * the delta that added it), and clamping it there would corrupt the batch's
 * true sum.
 */
export function sumProgress(
  batchId: Id<"batches">,
  experimentId: Id<"experiments">,
  rows: ProgressValues[],
): ProgressValues {
  const summed = emptyProgress(batchId, experimentId, 0);
  for (const row of rows) {
    for (const key of COUNTER_KEYS) summed[key] += row[key];
    for (const [failure, count] of Object.entries(row.failureCounts)) {
      const next = (summed.failureCounts[failure] ?? 0) + count;
      if (next === 0) delete summed.failureCounts[failure];
      else summed.failureCounts[failure] = next;
    }
    summed.firstStartedAt = minDefined(summed.firstStartedAt, row.firstStartedAt);
    summed.minEnergyEh = minDefined(summed.minEnergyEh, row.minEnergyEh);
    summed.lastFinishedAt = maxDefined(summed.lastFinishedAt, row.lastFinishedAt);
    summed.updatedAt = Math.max(summed.updatedAt, row.updatedAt);
  }
  return summed;
}

/**
 * mergeProgress sums ALL of a batch's delta rows into the single view the
 * dashboard reads. This is the only place the counters become non-negative: an
 * individual row is a delta and may be negative, while their total is the
 * truth. The clamp still guards that total, because a rollup can drift (rows
 * lost with a deleted batch, an ingest burst past the read cap) and "-1
 * running" is a worse lie than 0. The backfill migration is the repair path.
 */
export function mergeProgress(
  batchId: Id<"batches">,
  experimentId: Id<"experiments">,
  rows: ProgressValues[],
): ProgressValues {
  const merged = sumProgress(batchId, experimentId, rows);
  for (const key of COUNTER_KEYS) {
    if (!SIGNED_COUNTER_KEYS.has(key)) merged[key] = Math.max(0, merged[key]);
  }
  for (const [failure, count] of Object.entries(merged.failureCounts)) {
    if (count <= 0) delete merged.failureCounts[failure];
  }
  return merged;
}

function minDefined(a: number | undefined, b: number | undefined) {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}

function maxDefined(a: number | undefined, b: number | undefined) {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

// --- the dense-table projection ----------------------------------------------

/** One row of the paginated batch table. Deliberately field-by-field rather
 *  than a spread: `inputText` is a whole ORCA input file per run, and a 200-row
 *  page of those is megabytes of payload the table never renders. */
export interface BatchRunRow {
  _id: Id<"runs">;
  experimentId: Id<"experiments">;
  name?: string;
  status: RunStatus;
  exitCode?: number;
  errorClass?: string;
  errorExcerpt?: string;
  startedAt: number;
  finishedAt?: number;
  wallclockSec?: number;
  nprocs?: number;
  ncores?: number;
  lastEnergy?: number;
  gibbsEh?: number;
  gMinusEEh?: number;
  converged?: boolean;
  optMaxCycles?: boolean;
  imaginaryModes?: number;
  functional?: string;
  basis?: string;
  method?: string;
  runTypes?: string[];
  batchParams?: Record<string, string | number | boolean>;
  tags?: string[];
}

export function projectBatchRow(r: Doc<"runs">): BatchRunRow {
  return {
    _id: r._id,
    experimentId: r.experimentId,
    name: r.name,
    status: r.status,
    exitCode: r.exitCode,
    errorClass: r.errorClass,
    errorExcerpt: r.errorExcerpt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    wallclockSec: r.wallclockSec,
    nprocs: r.nprocs,
    ncores: r.ncores,
    lastEnergy: r.lastEnergy,
    gibbsEh: r.gibbsEh,
    gMinusEEh: r.gMinusEEh,
    converged: r.converged,
    optMaxCycles: r.optMaxCycles,
    imaginaryModes: r.imaginaryModes,
    functional: r.functional,
    basis: r.basis,
    method: r.method,
    runTypes: r.runTypes,
    batchParams: r.batchParams,
    tags: r.tags,
  };
}
