import type { Doc, Id } from "../_generated/dataModel";
import { RUN_STATUS } from "../schema";

// Pure tally logic behind experiments.listWithSummary. The db reads/writes stay
// in experiments.ts / lib/experimentProgressWriter.ts; everything here is a
// plain function over plain objects, so it is unit-testable without convex-test
// (see experimentSummary.test.ts) — same split as lib/batchSummary.ts.
//
// The summary used to be computed by reading the experiment's runs (capped at
// 500) inside the list query. That is O(runs) per experiment per page: one
// experiment with a few hundred runs was enough to push the query past Convex's
// per-transaction read budget, and the experiments index then rendered
// skeletons forever because the query threw on every attempt.
//
// It is now O(1) per experiment: a rollup of appended deltas (this file's
// arithmetic, the `experimentProgress` table) plus a single read of the
// newest run.
//
// The rollup is maintained as a DIFF, exactly like batchSummary: a mutation
// that touches a run computes the run's contribution before and after the write
// and appends (after - before). Repeated identical writes therefore produce a
// zero delta and are dropped instead of double-counting. DELTA ROWS MAY HOLD
// NEGATIVE COUNTS — only the merged sum is meaningful, and only
// mergeExperimentProgress clamps.

// --- the rollup --------------------------------------------------------------

/** One `experimentProgress` row's values (the schema's columns, as plain data
 *  so the arithmetic can be tested without a database). */
export type ExperimentProgressValues = {
  experimentId: Id<"experiments">;
  total: number;
  running: number;
  finished: number;
  failed: number;
  functionalCounts: Record<string, number>;
  basisCounts: Record<string, number>;
  runTypeCounts: Record<string, number>;
  updatedAt: number;
};

/** The run fields the rollup depends on. A Pick (not the full Doc) so the
 *  tests stay honest about what the tally actually reads. */
export type ExperimentRun = Pick<
  Doc<"runs">,
  "experimentId" | "status" | "functional" | "basis" | "runTypes"
>;

/** Additive counters — every one is maintained by summing deltas. */
const COUNTER_KEYS = ["total", "running", "finished", "failed"] as const;
type CounterKey = (typeof COUNTER_KEYS)[number];

/** The three value→count maps, likewise summed. */
const RECORD_KEYS = [
  "functionalCounts",
  "basisCounts",
  "runTypeCounts",
] as const;
type RecordKey = (typeof RECORD_KEYS)[number];

export function emptyExperimentProgress(
  experimentId: Id<"experiments">,
  now: number,
): ExperimentProgressValues {
  return {
    experimentId,
    total: 0,
    running: 0,
    finished: 0,
    failed: 0,
    functionalCounts: {},
    basisCounts: {},
    runTypeCounts: {},
    updatedAt: now,
  };
}

// A pending run is shown as running on the card: it is queued work, not a
// result. Anything that is neither terminal state nor queued/executing (there
// is no such status today) would count towards `total` only.
function statusCounter(status: Doc<"runs">["status"]): CounterKey | undefined {
  if (status === RUN_STATUS.RUNNING || status === RUN_STATUS.PENDING) {
    return "running";
  }
  if (status === RUN_STATUS.FINISHED) return "finished";
  if (status === RUN_STATUS.FAILED) return "failed";
  return undefined;
}

function bump(counts: Record<string, number>, key: string, sign: number): void {
  const next = (counts[key] ?? 0) + sign;
  // A key that nets to zero carries no information; dropping it keeps delta
  // rows small (a status-only change writes no functional/basis keys at all).
  if (next === 0) delete counts[key];
  else counts[key] = next;
}

function accumulate(
  into: ExperimentProgressValues,
  run: ExperimentRun,
  sign: number,
): void {
  into.total += sign;
  const counter = statusCounter(run.status);
  if (counter) into[counter] += sign;
  if (run.functional) bump(into.functionalCounts, run.functional, sign);
  if (run.basis) bump(into.basisCounts, run.basis, sign);
  // Not de-duplicated: a run that genuinely lists a type twice contributed
  // twice to the old scan-based tally too, and the delta is symmetric either
  // way (the same array is subtracted on the way out).
  for (const runType of run.runTypes ?? []) {
    bump(into.runTypeCounts, runType, sign);
  }
}

/**
 * experimentDelta is what one run write appends to the rollup: the run's
 * contribution after the write minus its contribution before it.
 *
 * Pass null for `before` on a creation and null for `after` on a deletion.
 */
export function experimentDelta(
  experimentId: Id<"experiments">,
  before: ExperimentRun | null,
  after: ExperimentRun | null,
  now: number,
): ExperimentProgressValues {
  const delta = emptyExperimentProgress(experimentId, now);
  if (before) accumulate(delta, before, -1);
  if (after) accumulate(delta, after, +1);
  return delta;
}

/** True when a delta changes nothing — the common case for the result-only
 *  patches the wrapper sends (`updateStatus` with no status change). Such a row
 *  would only add read cost to every future summary, so it is never written. */
export function isZeroExperimentDelta(v: ExperimentProgressValues): boolean {
  for (const key of COUNTER_KEYS) if (v[key] !== 0) return false;
  for (const key of RECORD_KEYS) {
    if (Object.keys(v[key]).length > 0) return false;
  }
  return true;
}

/**
 * sumExperimentProgress adds rows without clamping.
 *
 * Used by compaction, whose rows are a SUBSET of the experiment: a subset's
 * total may legitimately be negative (a delete row folded without the create
 * row it cancels), and clamping there would corrupt the experiment's real sum.
 */
export function sumExperimentProgress(
  experimentId: Id<"experiments">,
  rows: readonly ExperimentProgressValues[],
  now: number,
): ExperimentProgressValues {
  const out = emptyExperimentProgress(experimentId, now);
  for (const row of rows) {
    for (const key of COUNTER_KEYS) out[key] += row[key];
    for (const key of RECORD_KEYS) {
      for (const [value, count] of Object.entries(row[key])) {
        bump(out[key], value, count);
      }
    }
  }
  return out;
}

/**
 * mergeExperimentProgress sums a full set of rows into the view the UI reads,
 * clamping at zero.
 *
 * Clamping matters when the read was capped: the rows are the OLDEST ones, so a
 * truncated read can be missing the creations that its deletions cancel. The
 * result is then an under-count, never a negative one — and the caller flags it
 * (see runCountCapped) rather than presenting it as the truth.
 */
export function mergeExperimentProgress(
  experimentId: Id<"experiments">,
  rows: readonly ExperimentProgressValues[],
  now: number,
): ExperimentProgressValues {
  const summed = sumExperimentProgress(experimentId, rows, now);
  for (const key of COUNTER_KEYS) summed[key] = Math.max(0, summed[key]);
  for (const key of RECORD_KEYS) {
    for (const [value, count] of Object.entries(summed[key])) {
      if (count <= 0) delete summed[key][value];
    }
  }
  return summed;
}

// --- the card's view ----------------------------------------------------------

export type SummaryExperiment = {
  _id: Id<"experiments">;
  name: string;
  createdAt: number;
};

/** The newest run, read directly rather than rolled up: `latestRunName` must
 *  follow a rename, and one document per experiment is O(1). */
export type LatestRun = Pick<
  Doc<"runs">,
  "_id" | "status" | "name" | "startedAt" | "finishedAt" | "lastEnergy"
>;

/**
 * computeExperimentSummary assembles one experiment card.
 *
 * `progress` is null when the experiment has no rollup rows at all — an
 * experiment that predates the rollup and has not been backfilled yet. That is
 * reported as `summaryPending` rather than as an experiment with zero runs,
 * because "0 runs" is a claim about the data and this is an absence of it.
 */
export function computeExperimentSummary(
  e: SummaryExperiment,
  progress: ExperimentProgressValues | null,
  latest: LatestRun | null,
  capped = false,
) {
  return {
    _id: e._id,
    name: e.name,
    createdAt: e.createdAt,
    runCount: progress?.total ?? 0,
    // True when the rollup held more delta rows than one read may sum, so the
    // tallies are a lower bound. Rendered as "N+".
    runCountCapped: capped,
    summaryPending: progress === null,
    running: progress?.running ?? 0,
    finished: progress?.finished ?? 0,
    failed: progress?.failed ?? 0,
    lastActivity: latest?.finishedAt ?? latest?.startedAt ?? e.createdAt,
    latestStatus: latest?.status,
    latestRunName: latest?.name,
    latestRunId: latest?._id,
    latestLastEnergy: latest?.lastEnergy,
    topFunctional: topCount(progress?.functionalCounts),
    topBasis: topCount(progress?.basisCounts),
    topRunType: topCount(progress?.runTypeCounts),
  };
}

function topCount(c: Record<string, number> | undefined) {
  let best: string | undefined;
  let n = 0;
  for (const [k, count] of Object.entries(c ?? {})) {
    if (count > n) {
      best = k;
      n = count;
    }
  }
  return best;
}
