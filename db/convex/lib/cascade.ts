import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { drainProgress } from "./batchProgressWriter";
import type { StepBudget } from "./stepBudget";

// The pure (unregistered) half of the experiment / run delete cascade. The
// registered steps that chain through the scheduler stay in experiments.ts —
// their names are baked into jobs already sitting in _scheduled_functions, so
// they cannot move — and call into the helpers here.
//
// --- deleting an experiment ---------------------------------------------------
//
// experiments.remove pops the experiment row — which is all the experiments
// index reads — and hands the cascade to the scheduler. Everything underneath
// it (pathways, batches and their rollups, runs, every per-run child table,
// and finally the experiment's own rollup rows) is deleted by a chain of
// internalMutations, each of which is ONE bounded transaction. Children are
// orphaned for a few seconds while the chain works; nothing in the UI can
// reach them.
//
// Why bounded steps, and why exactly one job in flight:
//
//   * A Convex mutation is a transaction with a hard ceiling on operations
//     (every read, every write, every scheduler call) and on bytes read. The
//     previous cascade read up to 1,000 batches AND each of their rollup rows
//     AND every pathway (an unbounded .collect()) AND 100 runs, then scheduled
//     100 follow-up jobs — all in one transaction. lib/stepBudget.ts holds the
//     accounting that replaces the guesswork.
//   * It fanned out one self-rescheduling cleanup chain PER RUN. Deleting an
//     experiment with a few hundred runs left hundreds of mutations contending
//     in the scheduler; the backend answered "too many system operations" and
//     the chains retried for ten minutes without ever draining. The chain runs
//     strictly serially, with STEP_DELAY_MS of breathing room between steps so
//     concurrent UI queries interleave.
//
// Termination is structural, not a step cap: a step only reschedules ITSELF
// after deleting at least one row (see madeProgress), and rows are finite; the
// phase hand-offs (runs → run children → pathways/batches → rollup) are a
// finite sequence.

/** Milliseconds between cleanup steps. Long enough that the cascade never
 *  monopolises the backend, short enough that a large delete still finishes. */
export const STEP_DELAY_MS = 50;

/** Runs whose rows one step deletes (and whose ids it hands to the child
 *  cleanup step). Bounded by the byte budget too: a run inlines its ORCA input,
 *  so 32 of them is ~2 MiB in the worst case. */
export const RUNS_PER_SLICE = 32;
/** Pathways per slice: each inlines its point array. */
const PATHWAYS_PER_SLICE = 32;
/** Batches per slice. Small because every batch drags its rollup rows along. */
const BATCHES_PER_SLICE = 16;

/**
 * drainExperimentTopLevel deletes an experiment's own children — pathways,
 * then batches with their rollup rows — within `budget`. Returns true once
 * none are left.
 *
 * The batch rollups go with their batches, which is why the runs phase skips
 * recordRunChange: decrementing a rollup that is about to be deleted wholesale
 * is pure cost. A batch beyond this slice keeps its rollup until a later step
 * deletes it.
 */
export async function drainExperimentTopLevel(
  ctx: MutationCtx,
  experimentId: Id<"experiments">,
  budget: StepBudget,
): Promise<boolean> {
  for (;;) {
    const limit = budget.rowsAffordable("pathways", PATHWAYS_PER_SLICE);
    if (limit === 0) return false;
    budget.spendOps(1); // the index probe behind .take
    const pathways = await ctx.db
      .query("pathways")
      .withIndex("by_experiment", (q) => q.eq("experimentId", experimentId))
      .take(limit);
    budget.spendRows("pathways", pathways.length);
    for (const p of pathways) await ctx.db.delete(p._id);
    if (pathways.length < limit) break;
  }

  for (;;) {
    const limit = budget.rowsAffordable("batches", BATCHES_PER_SLICE);
    if (limit === 0) return false;
    budget.spendOps(1);
    const batches = await ctx.db
      .query("batches")
      .withIndex("by_experiment_createdAt", (q) =>
        q.eq("experimentId", experimentId),
      )
      .take(limit);
    budget.spendRows("batches", batches.length);
    for (const batch of batches) {
      if (!(await drainProgress(ctx, batch._id, budget))) return false;
      await ctx.db.delete(batch._id);
    }
    if (batches.length < limit) return true;
  }
}

/**
 * madeProgress guards every self-reschedule. A step that would continue having
 * deleted nothing is a bug (a slice ceiling that rounds to zero, an index that
 * never drains) and rescheduling it spins forever — which is precisely the
 * ten-minute retry storm the bounded cascade exists to end. Report it and stop;
 * the rows left behind are orphans no query can reach, and a later delete of
 * the same parent picks them up.
 */
export function madeProgress(budget: StepBudget, what: string): boolean {
  if (budget.rowsDeleted > 0) return true;
  console.error(
    `experiments cleanup: step for ${what} deleted nothing and would have rescheduled itself; stopping the cascade`,
  );
  return false;
}
