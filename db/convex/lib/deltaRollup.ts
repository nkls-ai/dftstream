import type { NamedTableInfo, Query, WithoutSystemFields } from "convex/server";
import type { DataModel, Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { StepBudget } from "./stepBudget";

// The storage skeleton shared by the two append-delta rollups (batchProgress,
// experimentProgress). Each rollup is a pile of signed delta rows under one
// owner id; their sum is the truth. This module owns everything that is the
// same for both — how the pile is read, appended to, compacted and drained —
// so a fix to one (the newest-first read below was first made to only one of
// them) cannot drift from the other again. The arithmetic stays in
// lib/batchSummary.ts / lib/experimentSummary.ts; the ctx-bound wiring in
// lib/batchProgressWriter.ts / lib/experimentProgressWriter.ts.
//
// Why appended deltas at all, and why compaction cannot conflict with ingest:
// see the long note at the top of lib/batchProgressWriter.ts.

/** Tables maintained as append-delta rollups. */
export type RollupTable = "batchProgress" | "experimentProgress";

/** How one rollup table is laid out. `owner` is the id the pile hangs off. */
export interface RollupSpec<T extends RollupTable, Owner> {
  table: T;
  /** Rows summed by one read; past it the read reports `capped`. */
  readCap: number;
  /** Rows folded into one per compaction pass (and deleted per drain slice). */
  compactRowLimit: number;
  /** Chance that an append schedules a compaction. A rate limiter: one
   *  compaction is one transaction, and scheduling too many of them during a
   *  large ingest overwhelms the backend (measured). */
  compactProbability: number;
  /** The owner's rows via its index, in (owner, _creationTime) order. Spelled
   *  out per table so the index name and field stay schema-checked. */
  rows: (ctx: QueryCtx, owner: Owner) => Query<NamedTableInfo<DataModel, T>>;
}

/**
 * readRollupRows returns an owner's delta rows, or null when it has none at
 * all (the owner predates the rollup and has not been backfilled — which
 * callers report as "pending" rather than as zeroes).
 *
 * Newest first, which matters only when the read is capped: compaction folds
 * the OLDEST rows and inserts the folded total as a NEW row, so the row that
 * carries the bulk of the rollup always sits at the END of the index. Reading
 * ascending would drop exactly that row when the pile is deep. `capped` says
 * the read hit its ceiling and the sum is a lower bound.
 */
export async function readRollupRows<T extends RollupTable, Owner>(
  ctx: QueryCtx,
  spec: RollupSpec<T, Owner>,
  owner: Owner,
): Promise<{ rows: Doc<T>[]; capped: boolean } | null> {
  const rows = await spec.rows(ctx, owner).order("desc").take(spec.readCap);
  if (rows.length === 0) return null;
  return { rows, capped: rows.length === spec.readCap };
}

/**
 * appendRollupDelta inserts one delta row and, with the spec's probability,
 * schedules a compaction through `scheduleCompaction`. The insert reads
 * nothing, so it conflicts with nothing — any number of writers can append to
 * one owner concurrently.
 */
export async function appendRollupDelta<T extends RollupTable, Owner>(
  ctx: MutationCtx,
  spec: RollupSpec<T, Owner>,
  delta: WithoutSystemFields<Doc<T>>,
  scheduleCompaction: () => Promise<unknown>,
): Promise<void> {
  await ctx.db.insert(spec.table, delta);
  // Math.random() is Convex's seeded, replay-safe RNG. Compaction is pure
  // maintenance: scheduling it too often only wastes a transaction, and
  // skipping it only leaves more rows for the next read to sum.
  if (Math.random() < spec.compactProbability) await scheduleCompaction();
}

/**
 * compactRollup folds the oldest rows of one owner into a single row, and
 * reports whether it filled its slice — a caller that sees `more` schedules
 * another pass, so a burst of ingest is cleaned up by a chain instead of by
 * luck.
 *
 * `fold` must SUM without clamping: the rows are a subset of the pile and a
 * subset's total may legitimately be negative.
 *
 * It reads a bounded PREFIX of the (owner, _creationTime) index, so deltas
 * appended while it runs sit beyond its read set and do not conflict with it.
 * Two compactions racing each other is the one conflict that can happen; the
 * loser rolls back having changed nothing. It can never lose a delta.
 */
export async function compactRollup<T extends RollupTable, Owner>(
  ctx: MutationCtx,
  spec: RollupSpec<T, Owner>,
  owner: Owner,
  fold: (rows: Doc<T>[]) => WithoutSystemFields<Doc<T>>,
): Promise<{ compacted: number; more: boolean }> {
  const rows = await spec.rows(ctx, owner).take(spec.compactRowLimit);
  if (rows.length < 2) return { compacted: 0, more: false };
  const folded = fold(rows);
  for (const row of rows) await ctx.db.delete(row._id);
  await ctx.db.insert(spec.table, folded);
  return {
    compacted: rows.length,
    more: rows.length === spec.compactRowLimit,
  };
}

/**
 * drainRollup deletes an owner's rows within `budget`, returning true once none
 * are left. Bounded rather than collect(): an owner deleted mid-ingest can hold
 * more rows than one transaction may touch, and an unbounded read would fail
 * the whole delete. A false return means "schedule another step".
 */
export async function drainRollup<T extends RollupTable, Owner>(
  ctx: MutationCtx,
  spec: RollupSpec<T, Owner>,
  owner: Owner,
  budget: StepBudget,
): Promise<boolean> {
  for (;;) {
    const limit = budget.rowsAffordable(spec.table, spec.compactRowLimit);
    if (limit === 0) return false;
    budget.spendOps(1); // the index probe behind .take
    const rows = await spec.rows(ctx, owner).take(limit);
    budget.spendRows(spec.table, rows.length);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length < limit) return true;
  }
}
