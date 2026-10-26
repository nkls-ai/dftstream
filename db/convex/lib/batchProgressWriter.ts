import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  applyContribution,
  emptyProgress,
  isZeroContributionChange,
  mergeProgress,
  runContribution,
  sumProgress,
  type ProgressRun,
  type ProgressValues,
} from "./batchSummary";
import {
  appendRollupDelta,
  compactRollup,
  drainRollup,
  readRollupRows,
  type RollupSpec,
} from "./deltaRollup";
import { recordExperimentRunChange } from "./experimentProgressWriter";
import type { ExperimentRun } from "./experimentSummary";
import { StepBudget } from "./stepBudget";

// The thin ctx-bound layer over lib/batchSummary.ts. Every mutation that
// creates, patches or deletes a run goes through recordRunChange, so the
// counters are committed in the SAME transaction as the run itself — a
// dashboard can never observe a run and the rollup disagreeing.
//
// Lives in lib/ rather than in runs.ts because experiments.ts (run deletion,
// batch deletion) needs it too, and runs.ts already re-exports from
// experiments.ts — importing the other way round would close a cycle.
//
// --- why a batch's rollup is several rows ------------------------------------
//
// The obvious design — one document per batch, read-modify-written by each run
// mutation — does not work. That document is the hottest row in the deployment
// during an ingest, and Convex's optimistic concurrency control fails a write
// whose read set changed under it. Measured on the local backend: at just TWO
// concurrent clients seeding runs into one batch, retries are exhausted within
// seconds and `runs.create` starts returning OCC errors. Losing runs to keep a
// statistic is a terrible trade.
//
// So a run write only ever APPENDS its delta — an insert reads nothing, so it
// conflicts with nothing, and any number of clients can ingest in parallel.
// Reads sum the rows. compactBatchProgress folds the oldest rows back into one
// so the sum stays cheap; because it reads a bounded PREFIX of the index
// (batchId, _creationTime), and new deltas append after that prefix,
// compaction does not conflict with concurrent ingest either. The shared
// read/append/compact/drain skeleton lives in lib/deltaRollup.ts.

/** A run as the rollups see it: its tallied fields plus where it belongs.
 *  ExperimentRun widens this with the few extra columns the experiment-level
 *  rollup counts (functional, basis), so one call site feeds both. */
export type BatchedRun = ProgressRun &
  ExperimentRun & {
    batchId?: Id<"batches">;
  };

/** Rows summed by a single read. Compaction keeps the real count far below
 *  this; the cap only bounds the worst case (a burst of ingest between two
 *  compactions), where the read reports `capped` and under-reports. */
export const ROLLUP_READ_CAP = 512;

/** Rows folded into one per compaction pass — twice the expected gap between
 *  passes, so a pass normally catches up, while the deletes stay a small
 *  transaction. A pass that fills its slice chains another. */
export const COMPACT_ROW_LIMIT = 64;

/**
 * The batch rollup's storage layout.
 *
 * Compaction probability is a rate limiter, not a nicety: at 1/8 a 5,000-run
 * ingest schedules ~1,500 compactions and the backend buckles ("timed out
 * performing too many system operations", measured). At 1/32 the expected gap
 * is ~32 appended rows — far under ROLLUP_READ_CAP — for ~370 compaction
 * transactions across that same ingest.
 */
export const BATCH_ROLLUP: RollupSpec<"batchProgress", Id<"batches">> = {
  table: "batchProgress",
  readCap: ROLLUP_READ_CAP,
  compactRowLimit: COMPACT_ROW_LIMIT,
  compactProbability: 1 / 32,
  rows: (ctx, batchId) =>
    ctx.db
      .query("batchProgress")
      .withIndex("by_batch", (q) => q.eq("batchId", batchId)),
};

/** What the batchProgress query returns: the merged rollup, plus whether the
 *  read hit ROLLUP_READ_CAP (the totals are then a lower bound). */
export type BatchProgressView = ProgressValues & { capped: boolean };

/** readProgress sums a batch's delta rows into one view, or returns null when
 *  the batch has no rollup at all (it predates the rollup and has not been
 *  backfilled — which the UI reports rather than showing zeroes). */
export async function readProgress(
  ctx: QueryCtx,
  batchId: Id<"batches">,
  experimentId: Id<"experiments">,
): Promise<BatchProgressView | null> {
  const read = await readRollupRows(ctx, BATCH_ROLLUP, batchId);
  if (!read) return null;
  return {
    ...mergeProgress(batchId, experimentId, read.rows),
    capped: read.capped,
  };
}

/**
 * recordRunChange appends a run's transition to its batch's rollup.
 *
 * `before`/`after` are the run document as it was and as it now is; pass null
 * for a creation or a deletion. A run with no batchId contributes nothing. If
 * the run changed batches, the old batch gets the removal and the new one the
 * addition.
 */
export async function recordRunChange(
  ctx: MutationCtx,
  before: BatchedRun | null,
  after: BatchedRun | null,
): Promise<void> {
  // The experiment rollup counts EVERY run, batched or not, so it is recorded
  // ahead of the batch-less early return below. Same transaction as the run
  // write, for the same reason: a card can never observe a run and the rollup
  // disagreeing.
  await recordExperimentRunChange(ctx, before, after);

  const fromBatch = before?.batchId;
  const toBatch = after?.batchId;
  if (!fromBatch && !toBatch) return;

  if (fromBatch && toBatch && fromBatch === toBatch) {
    await appendDelta(ctx, toBatch, after!.experimentId, before, after);
    return;
  }
  if (fromBatch) {
    await appendDelta(ctx, fromBatch, before!.experimentId, before, null);
  }
  if (toBatch) {
    await appendDelta(ctx, toBatch, after!.experimentId, null, after);
  }
}

async function appendDelta(
  ctx: MutationCtx,
  batchId: Id<"batches">,
  experimentId: Id<"experiments">,
  before: BatchedRun | null,
  after: BatchedRun | null,
): Promise<void> {
  const beforeC = before ? runContribution(before) : null;
  const afterC = after ? runContribution(after) : null;
  // A replayed or result-only patch that moves nothing appends nothing — the
  // row would only add read cost to every future dashboard read.
  if (beforeC && afterC && isZeroContributionChange(beforeC, afterC)) return;
  const now = Date.now();
  const delta = applyContribution(
    emptyProgress(batchId, experimentId, now),
    beforeC,
    afterC,
    now,
  );
  await appendRollupDelta(ctx, BATCH_ROLLUP, delta, () =>
    ctx.scheduler.runAfter(0, internal.runs.compactBatchProgress, { batchId }),
  );
}

/** compactProgress folds the oldest rows of one batch into a single row; `more`
 *  asks the caller to chain another pass. See lib/deltaRollup.compactRollup for
 *  why this never conflicts with ingest and can never lose a delta. */
export async function compactProgress(
  ctx: MutationCtx,
  batchId: Id<"batches">,
): Promise<{ compacted: number; more: boolean }> {
  // sumProgress, not mergeProgress: these rows are a SUBSET of the batch, and
  // a subset's total may be negative — clamping it here would corrupt the
  // batch's real sum.
  return await compactRollup(ctx, BATCH_ROLLUP, batchId, (rows) =>
    sumProgress(batchId, rows[0]!.experimentId, rows),
  );
}

/** initProgress seeds a brand-new batch with a zeroed row, so an empty batch
 *  reads as "0 of 0" instead of as a batch whose rollup was never built. */
export async function initProgress(
  ctx: MutationCtx,
  batchId: Id<"batches">,
  experimentId: Id<"experiments">,
): Promise<void> {
  await ctx.db.insert("batchProgress", emptyProgress(batchId, experimentId, Date.now()));
}

/** drainProgress deletes a batch's rollup rows within `budget`, returning true
 *  once none are left (false: schedule another step to finish the job). */
export async function drainProgress(
  ctx: MutationCtx,
  batchId: Id<"batches">,
  budget: StepBudget,
): Promise<boolean> {
  return await drainRollup(ctx, BATCH_ROLLUP, batchId, budget);
}

/**
 * replaceProgress overwrites a batch's rollup wholesale — the backfill's
 * write, which is what makes rebuilding idempotent.
 *
 * Returns false when the old rows did not all fit in this transaction. It then
 * writes NOTHING (half the old rows plus a new total would double-count the
 * batch) but it has still deleted rows, so a caller that retries the step
 * converges. Never silently partial — the old fixed-pass removal could leave
 * survivors behind and then add the rebuilt total on top of them.
 */
export async function replaceProgress(
  ctx: MutationCtx,
  values: ProgressValues,
): Promise<boolean> {
  if (!(await drainProgress(ctx, values.batchId, new StepBudget()))) {
    return false;
  }
  await ctx.db.insert("batchProgress", values);
  return true;
}
