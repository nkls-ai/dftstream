import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { StepBudget } from "./stepBudget";
import {
  appendRollupDelta,
  compactRollup,
  drainRollup,
  readRollupRows,
  type RollupSpec,
} from "./deltaRollup";
import {
  emptyExperimentProgress,
  experimentDelta,
  isZeroExperimentDelta,
  mergeExperimentProgress,
  sumExperimentProgress,
  type ExperimentProgressValues,
  type ExperimentRun,
} from "./experimentSummary";

// The thin ctx-bound layer over the experiment rollup arithmetic in
// lib/experimentSummary.ts — the experiment-level twin of
// lib/batchProgressWriter.ts, and appended from the same place (recordRunChange)
// so a run and its rollup delta always commit in one transaction. The storage
// skeleton (read / append / compact / drain) is shared with the batch rollup in
// lib/deltaRollup.ts.
//
// Why appended deltas rather than one document per experiment: identical to the
// batch case, only worse. A single row would be read-modify-written by every
// run mutation in the experiment — i.e. by every batch in it at once — and
// Convex fails a write whose read set changed underneath it. An insert reads
// nothing, so it conflicts with nothing. See the long note at the top of
// lib/batchProgressWriter.ts for the measurements.

/**
 * Delta rows summed by one read of one experiment.
 *
 * Sizing: the experiments page requests at most 100 experiments per page, so a
 * single listWithSummary transaction reads up to 100 x 96 = 9,600 rollup rows
 * plus 100 run documents — under Convex's 16,384-document read ceiling, and a
 * few hundred KiB of tiny rows against the 8 MiB byte ceiling. Compaction keeps
 * the real count near COMPACT_PROBABILITY's expected gap (~32), so the typical
 * page reads a few hundred rows, not thousands.
 */
export const EXPERIMENT_ROLLUP_READ_CAP = 96;

/** Rows folded into one per compaction pass. Above the expected gap, so a pass
 *  normally catches up completely; when it does not it schedules itself again. */
export const EXPERIMENT_COMPACT_ROW_LIMIT = 64;

/** The experiment rollup's storage layout. Compaction probability: at 1/8 a
 *  multi-thousand-run ingest schedules enough compactions to overwhelm the
 *  backend (measured for batchProgress, same shape); at 1/32 the expected gap
 *  is ~32 appended rows — comfortably under EXPERIMENT_ROLLUP_READ_CAP. */
export const EXPERIMENT_ROLLUP: RollupSpec<
  "experimentProgress",
  Id<"experiments">
> = {
  table: "experimentProgress",
  readCap: EXPERIMENT_ROLLUP_READ_CAP,
  compactRowLimit: EXPERIMENT_COMPACT_ROW_LIMIT,
  compactProbability: 1 / 32,
  rows: (ctx, experimentId) =>
    ctx.db
      .query("experimentProgress")
      .withIndex("by_experiment", (q) => q.eq("experimentId", experimentId)),
};

/**
 * readExperimentProgress sums an experiment's delta rows into one view.
 *
 * Returns null when the experiment has no rollup at all (it predates the rollup
 * and has not been backfilled) — which the caller reports as "pending" rather
 * than as an experiment with no runs. `capped` says the read hit its ceiling
 * and the tallies are a lower bound.
 */
export async function readExperimentProgress(
  ctx: QueryCtx,
  experimentId: Id<"experiments">,
): Promise<{ values: ExperimentProgressValues; capped: boolean } | null> {
  const read = await readRollupRows(ctx, EXPERIMENT_ROLLUP, experimentId);
  if (!read) return null;
  return {
    values: mergeExperimentProgress(experimentId, read.rows, Date.now()),
    capped: read.capped,
  };
}

/**
 * recordExperimentRunChange appends a run's transition to its experiment's
 * rollup. Pass null for `before` on a creation and null for `after` on a
 * deletion; a write that changes nothing the rollup counts appends nothing.
 */
export async function recordExperimentRunChange(
  ctx: MutationCtx,
  before: ExperimentRun | null,
  after: ExperimentRun | null,
): Promise<void> {
  const experimentId = after?.experimentId ?? before?.experimentId;
  if (!experimentId) return;
  const delta = experimentDelta(experimentId, before, after, Date.now());
  if (isZeroExperimentDelta(delta)) return;
  await appendRollupDelta(ctx, EXPERIMENT_ROLLUP, delta, () =>
    ctx.scheduler.runAfter(0, internal.experiments.compactExperimentProgress, {
      experimentId,
    }),
  );
}

/** compactExperimentProgress folds the oldest rows of one experiment into a
 *  single row; `more` asks the caller to chain another pass. See
 *  lib/deltaRollup.compactRollup for why this never conflicts with ingest. */
export async function compactExperimentProgress(
  ctx: MutationCtx,
  experimentId: Id<"experiments">,
): Promise<{ compacted: number; more: boolean }> {
  // sumExperimentProgress, not mergeExperimentProgress: these rows are a SUBSET
  // of the experiment and their total may be negative — clamping here would
  // corrupt the experiment's real sum.
  return await compactRollup(ctx, EXPERIMENT_ROLLUP, experimentId, (rows) =>
    sumExperimentProgress(experimentId, rows, Date.now()),
  );
}

/** initExperimentProgress seeds a brand-new experiment with a zeroed row, so an
 *  empty experiment reads as "0 runs" instead of as one whose rollup was never
 *  built (which the UI reports as still being counted). */
export async function initExperimentProgress(
  ctx: MutationCtx,
  experimentId: Id<"experiments">,
): Promise<void> {
  await ctx.db.insert(
    "experimentProgress",
    emptyExperimentProgress(experimentId, Date.now()),
  );
}

/** drainExperimentProgress deletes an experiment's rollup rows within
 *  `budget`, returning true once none are left. */
export async function drainExperimentProgress(
  ctx: MutationCtx,
  experimentId: Id<"experiments">,
  budget: StepBudget,
): Promise<boolean> {
  return await drainRollup(ctx, EXPERIMENT_ROLLUP, experimentId, budget);
}

/**
 * replaceExperimentProgress overwrites an experiment's rollup wholesale — the
 * backfill's write, which is what makes rebuilding idempotent.
 *
 * Returns false when the old rows did not all fit in this transaction. It then
 * writes NOTHING (leaving half the old rows plus a new total would double-count
 * the experiment) but it has still deleted rows, so a caller that simply
 * retries the step converges. Never silently partial.
 */
export async function replaceExperimentProgress(
  ctx: MutationCtx,
  values: ExperimentProgressValues,
): Promise<boolean> {
  const drained = await drainExperimentProgress(
    ctx,
    values.experimentId,
    new StepBudget(),
  );
  if (!drained) return false;
  await ctx.db.insert("experimentProgress", values);
  return true;
}
