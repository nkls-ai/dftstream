/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema, { RUN_STATUS } from "./schema";
import type { Id } from "./_generated/dataModel";
import { emptyProgress } from "./lib/batchSummary";
import {
  COMPACT_ROW_LIMIT,
  ROLLUP_READ_CAP,
} from "./lib/batchProgressWriter";
import { STEP_OP_BUDGET, OPS_PER_ROW } from "./lib/stepBudget";

const modules = import.meta.glob("./**/*.ts");

// The rollup piles that outgrow a single read or a single transaction: what
// happens to the batch rollup when ingest outruns compaction, and when a batch
// is deleted with a deep pile. Everyday rollup behaviour lives in
// batchProgress.test.ts.

const alice = { subject: "alice", issuer: "test", email: "alice@lab.edu" };

async function setup() {
  const t = convexTest(schema, modules);
  const as = t.withIdentity(alice);
  const { organizationId } = await as.mutation(api.organizations.create, {
    name: "Lab",
  });
  const experimentId = await as.mutation(api.experiments.ensure, {
    name: "screen",
    organizationId,
  });
  const batchId = await as.mutation(api.experiments.createBatch, {
    experimentId,
    name: "conformers",
  });
  return { t, as, experimentId, batchId };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

/** Appends `n` single-pending-run delta rows straight into the pile — the
 *  shape an ingest burst leaves behind when no compaction has run yet. */
async function pileUp(ctx: Ctx, n: number): Promise<void> {
  await ctx.t.run(async (mctx) => {
    for (let i = 0; i < n; i++) {
      await mctx.db.insert("batchProgress", {
        ...emptyProgress(ctx.batchId, ctx.experimentId, i + 1),
        total: 1,
        pending: 1,
      });
    }
  });
}

async function rowCount(ctx: Ctx, batchId: Id<"batches"> = ctx.batchId) {
  return await ctx.t.run(async (mctx) => {
    const rows = await mctx.db
      .query("batchProgress")
      .withIndex("by_batch", (q) => q.eq("batchId", batchId))
      .collect();
    return rows.length;
  });
}

async function progress(ctx: Ctx) {
  const row = await ctx.as.query(api.runs.batchProgress, { batchId: ctx.batchId });
  if (!row) throw new Error("expected a rollup");
  return row;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a rollup pile deeper than one read", () => {
  test("a compacted total at the end of a deep pile is never dropped", async () => {
    const ctx = await setup();
    // Past the read cap by a clear margin: 1 seed row + 600 deltas.
    const deltas = ROLLUP_READ_CAP + 88;
    await pileUp(ctx, deltas);

    // One compaction pass folds the OLDEST rows and appends the folded total
    // as the NEWEST row. The old ascending read took the first 512 rows and so
    // dropped exactly that row — the one carrying the bulk of the batch.
    const pass = await ctx.t.mutation(internal.runs.compactBatchProgress, {
      batchId: ctx.batchId,
    });
    expect(pass.compacted).toBe(COMPACT_ROW_LIMIT);
    expect(pass.more).toBe(true);

    const capped = await progress(ctx);
    expect(capped.capped).toBe(true);
    // Newest-first: the folded row (COMPACT_ROW_LIMIT - 1 deltas + the seed)
    // plus the ROLLUP_READ_CAP - 1 newest single-run deltas.
    expect(capped.total).toBe(COMPACT_ROW_LIMIT - 1 + ROLLUP_READ_CAP - 1);
    // The ascending read's answer, for the record: strictly worse.
    expect(capped.total).toBeGreaterThan(ROLLUP_READ_CAP);
  });

  test("compaction chains itself until the pile reads exactly again", async () => {
    const ctx = await setup();
    const deltas = ROLLUP_READ_CAP + 88;
    await pileUp(ctx, deltas);
    vi.useFakeTimers();
    await ctx.t.mutation(internal.runs.compactBatchProgress, {
      batchId: ctx.batchId,
    });
    await ctx.t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();

    expect(await rowCount(ctx)).toBeLessThan(COMPACT_ROW_LIMIT);
    const exact = await progress(ctx);
    expect(exact.capped).toBe(false);
    expect(exact).toMatchObject({ total: deltas, pending: deltas });
  });
});

describe("rollup rows that change nothing", () => {
  test("a replayed status update appends no rollup row", async () => {
    const ctx = await setup();
    const runId = await ctx.as.mutation(api.runs.create, {
      experimentId: ctx.experimentId,
      batchId: ctx.batchId,
    });
    const patch = {
      runId,
      status: RUN_STATUS.FINISHED,
      lastEnergy: -10,
      finishedAt: 1_700_000_000_000,
    };
    await ctx.as.mutation(api.runs.updateStatus, patch);
    const before = await rowCount(ctx);
    // The wrapper's replays and status-less repeats: each would have appended
    // an all-zero delta for every future read to sum.
    await ctx.as.mutation(api.runs.updateStatus, patch);
    await ctx.as.mutation(api.runs.updateStatus, { runId, lastEnergy: -10 });
    expect(await rowCount(ctx)).toBe(before);
    expect(await progress(ctx)).toMatchObject({ total: 1, finished: 1, energyCount: 1 });
  });

  test("a patch that only moves the finish time still records it", async () => {
    const ctx = await setup();
    const runId = await ctx.as.mutation(api.runs.create, {
      experimentId: ctx.experimentId,
      batchId: ctx.batchId,
    });
    await ctx.as.mutation(api.runs.updateStatus, {
      runId,
      status: RUN_STATUS.FINISHED,
      wallclockSec: 10,
      finishedAt: 1_700_000_000_000,
    });
    // Counters are unchanged (wallclockSec is explicit), but the batch's
    // lastFinishedAt must still advance — the zero-delta skip may not eat it.
    await ctx.as.mutation(api.runs.updateStatus, {
      runId,
      finishedAt: 1_700_000_500_000,
    });
    expect((await progress(ctx)).lastFinishedAt).toBe(1_700_000_500_000);
  });
});

describe("deleting a batch with a deep rollup", () => {
  test("rows past one transaction are drained by a follow-up chain", async () => {
    const ctx = await setup();
    // More rows than one step's operation budget can delete.
    const tooMany = Math.ceil(STEP_OP_BUDGET / OPS_PER_ROW) + 100;
    await pileUp(ctx, tooMany);
    vi.useFakeTimers();
    await ctx.as.mutation(api.experiments.removeBatch, { batchId: ctx.batchId });
    // The batch row is gone at once; some rollup rows are left for the chain.
    expect(await rowCount(ctx)).toBeGreaterThan(0);
    await ctx.t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
    expect(await rowCount(ctx)).toBe(0);
  });
});
