/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema, { ERROR_CLASS, RUN_STATUS } from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

// End-to-end cover for the batchProgress rollup: the arithmetic itself is
// tested in lib/batchSummary.test.ts, so what matters here is that the real
// mutations keep the counters in step with the runs table — including under
// the replayed and status-less patches the Go wrapper actually sends.

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

async function progress(ctx: Ctx, batchId?: Id<"batches">) {
  const row = await ctx.as.query(api.runs.batchProgress, {
    batchId: batchId ?? ctx.batchId,
  });
  if (!row) throw new Error("expected a rollup row");
  return row;
}

async function newRun(ctx: Ctx, batched = true) {
  return await ctx.as.mutation(api.runs.create, {
    experimentId: ctx.experimentId,
    batchId: batched ? ctx.batchId : undefined,
    inputText: "! B3LYP def2-SVP Opt\n*xyz 0 1\nH 0 0 0\n*\n",
  });
}

beforeEach(() => {
  vi.useRealTimers();
});

describe("batchProgress rollup", () => {
  test("a new batch starts with a zeroed rollup, not a missing one", async () => {
    const ctx = await setup();
    expect(await progress(ctx)).toMatchObject({
      total: 0,
      pending: 0,
      running: 0,
      finished: 0,
      failed: 0,
      failureCounts: {},
    });
  });

  test("creating runs moves them into pending", async () => {
    const ctx = await setup();
    await newRun(ctx);
    await newRun(ctx);
    expect(await progress(ctx)).toMatchObject({ total: 2, pending: 2 });
  });

  test("a run with no batchId contributes nothing", async () => {
    const ctx = await setup();
    await newRun(ctx, false);
    expect(await progress(ctx)).toMatchObject({ total: 0, pending: 0 });
  });

  test("pending → running → finished walks the counters", async () => {
    const ctx = await setup();
    const runId = await newRun(ctx);
    await ctx.as.mutation(api.runs.updateStatus, {
      runId,
      status: RUN_STATUS.RUNNING,
    });
    expect(await progress(ctx)).toMatchObject({ total: 1, pending: 0, running: 1 });

    await ctx.as.mutation(api.runs.updateStatus, {
      runId,
      status: RUN_STATUS.FINISHED,
      converged: true,
      gibbsEh: -76.4,
      lastEnergy: -76.42,
      wallclockSec: 120,
      nprocs: 4,
      finishedAt: 1_700_000_000_000,
    });
    expect(await progress(ctx)).toMatchObject({
      total: 1,
      running: 0,
      finished: 1,
      converged: 1,
      missingThermo: 0,
      wallclockSumSec: 120,
      coreSecondsSum: 480,
      energyCount: 1,
      minEnergyEh: -76.42,
    });
  });

  test("a repeated status update does not double-count", async () => {
    const ctx = await setup();
    const runId = await newRun(ctx);
    const patch = {
      runId,
      status: RUN_STATUS.FINISHED,
      lastEnergy: -10,
      gibbsEh: -10,
      wallclockSec: 5,
      finishedAt: 1_700_000_000_000,
    };
    await ctx.as.mutation(api.runs.updateStatus, patch);
    await ctx.as.mutation(api.runs.updateStatus, patch);
    await ctx.as.mutation(api.runs.updateStatus, patch);
    expect(await progress(ctx)).toMatchObject({
      total: 1,
      finished: 1,
      energyCount: 1,
      energySumEh: -10,
      wallclockSumSec: 5,
    });
  });

  test("a status-less result patch only moves the result counters", async () => {
    const ctx = await setup();
    const runId = await newRun(ctx);
    await ctx.as.mutation(api.runs.updateStatus, {
      runId,
      status: RUN_STATUS.FINISHED,
      lastEnergy: -10,
      finishedAt: 1_700_000_000_000,
    });
    expect(await progress(ctx)).toMatchObject({ finished: 1, missingThermo: 1 });

    // The Energies tab backfilling thermochemistry parsed from the .out —
    // no status in the payload at all.
    await ctx.as.mutation(api.runs.updateStatus, { runId, gibbsEh: -9.5 });
    expect(await progress(ctx)).toMatchObject({
      total: 1,
      finished: 1,
      missingThermo: 0,
    });
  });

  test("failures land in a bucket, by class when there is one", async () => {
    const ctx = await setup();
    const a = await newRun(ctx);
    const b = await newRun(ctx);
    await ctx.as.mutation(api.runs.updateStatus, {
      runId: a,
      status: RUN_STATUS.FAILED,
      exitCode: 1,
      errorClass: ERROR_CLASS.SCF_NOT_CONVERGED,
    });
    await ctx.as.mutation(api.runs.updateStatus, {
      runId: b,
      status: RUN_STATUS.FAILED,
      exitCode: 137,
    });
    const p = await progress(ctx);
    expect(p).toMatchObject({ failed: 2, suspicious: 2 });
    expect(p.failureCounts).toEqual({
      [ERROR_CLASS.SCF_NOT_CONVERGED]: 1,
      "exit:137": 1,
    });
  });

  test("restarting a failed run empties its failure bucket", async () => {
    const ctx = await setup();
    const runId = await newRun(ctx);
    await ctx.as.mutation(api.runs.updateStatus, {
      runId,
      status: RUN_STATUS.FAILED,
      errorClass: ERROR_CLASS.OUT_OF_MEMORY,
    });
    await ctx.as.mutation(api.runs.updateStatus, {
      runId,
      status: RUN_STATUS.RUNNING,
    });
    const p = await progress(ctx);
    expect(p).toMatchObject({ failed: 0, running: 1, total: 1 });
    expect(p.failureCounts).toEqual({});
  });

  test("deleting a run takes it back out of the rollup", async () => {
    const ctx = await setup();
    const runId = await newRun(ctx);
    await ctx.as.mutation(api.runs.updateStatus, {
      runId,
      status: RUN_STATUS.FINISHED,
      lastEnergy: -3,
      gibbsEh: -3,
      finishedAt: 1_700_000_000_000,
    });
    await ctx.as.mutation(api.runs.remove, { runId });
    expect(await progress(ctx)).toMatchObject({
      total: 0,
      finished: 0,
      energyCount: 0,
    });
  });

  test("a late lastEnergy patch keeps the energy aggregates honest", async () => {
    const ctx = await setup();
    const runId = await newRun(ctx);
    await ctx.as.mutation(api.runs.updateStatus, {
      runId,
      status: RUN_STATUS.FINISHED,
      gibbsEh: -1,
      finishedAt: 1_700_000_000_000,
    });
    expect(await progress(ctx)).toMatchObject({ energyCount: 0, suspicious: 1 });
    // Status-less result patch, exactly what the wrapper sends when the final
    // energy is parsed after the status update landed.
    await ctx.as.mutation(api.runs.updateStatus, { runId, lastEnergy: -42 });
    expect(await progress(ctx)).toMatchObject({
      energyCount: 1,
      energySumEh: -42,
      minEnergyEh: -42,
      suspicious: 0,
    });
  });

  test("deleting the batch drops its rollup", async () => {
    const ctx = await setup();
    await ctx.as.mutation(api.experiments.removeBatch, { batchId: ctx.batchId });
    await expect(
      ctx.as.query(api.runs.batchProgress, { batchId: ctx.batchId }),
    ).rejects.toThrow(/batch not found/);
  });
});

describe("rollup compaction", () => {
  /** How many rows the batch's rollup is currently spread across. */
  async function rowCount(ctx: Ctx): Promise<number> {
    return await ctx.t.run(async (runCtx) => {
      const rows = await runCtx.db
        .query("batchProgress")
        .withIndex("by_batch", (q) => q.eq("batchId", ctx.batchId))
        .collect();
      return rows.length;
    });
  }

  test("run writes append rather than rewrite a hot document", async () => {
    const ctx = await setup();
    // One row from batch creation, then one per run write. Appending is what
    // lets many clients ingest one batch at once without OCC failures.
    const before = await rowCount(ctx);
    const runId = await newRun(ctx);
    await ctx.as.mutation(api.runs.updateStatus, {
      runId,
      status: RUN_STATUS.RUNNING,
    });
    expect(await rowCount(ctx)).toBe(before + 2);
  });

  test("compaction folds the rows without changing a single total", async () => {
    const ctx = await setup();
    for (let i = 0; i < 6; i++) {
      const runId = await newRun(ctx);
      await ctx.as.mutation(api.runs.updateStatus, {
        runId,
        status: i % 2 === 0 ? RUN_STATUS.FINISHED : RUN_STATUS.FAILED,
        errorClass: i % 2 === 0 ? undefined : ERROR_CLASS.INPUT_ERROR,
        lastEnergy: i % 2 === 0 ? -70 - i : undefined,
        gibbsEh: i % 2 === 0 ? -70 : undefined,
        wallclockSec: 10 + i,
        finishedAt: 1_700_000_000_000 + i,
      });
    }
    const before = await progress(ctx);
    expect(await rowCount(ctx)).toBeGreaterThan(1);

    const res = await ctx.t.mutation(internal.runs.compactBatchProgress, {
      batchId: ctx.batchId,
    });
    expect(res.compacted).toBeGreaterThan(1);
    expect(await rowCount(ctx)).toBe(1);

    const after = await progress(ctx);
    expect(after).toMatchObject({
      total: before.total,
      finished: before.finished,
      failed: before.failed,
      energyCount: before.energyCount,
      energySumEh: before.energySumEh,
      minEnergyEh: before.minEnergyEh,
      wallclockSumSec: before.wallclockSumSec,
      coreSecondsSum: before.coreSecondsSum,
    });
    expect(after.failureCounts).toEqual(before.failureCounts);
  });

  test("compacting a batch with a single row is a no-op", async () => {
    const ctx = await setup();
    expect(
      await ctx.t.mutation(internal.runs.compactBatchProgress, {
        batchId: ctx.batchId,
      }),
    ).toEqual({ compacted: 0, more: false });
  });
});

describe("listByBatchPaged", () => {
  test("pages the batch and never ships inputText", async () => {
    const ctx = await setup();
    for (let i = 0; i < 5; i++) await newRun(ctx);
    const first = await ctx.as.query(api.runs.listByBatchPaged, {
      batchId: ctx.batchId,
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(first.page).toHaveLength(2);
    expect(first.isDone).toBe(false);
    for (const row of first.page) {
      expect("inputText" in row).toBe(false);
    }
    const second = await ctx.as.query(api.runs.listByBatchPaged, {
      batchId: ctx.batchId,
      paginationOpts: { numItems: 10, cursor: first.continueCursor },
    });
    expect(second.page).toHaveLength(3);
    expect(second.isDone).toBe(true);
  });

  test("the rollup knows the whole batch, a page only its page", async () => {
    const ctx = await setup();
    for (let i = 0; i < 12; i++) await newRun(ctx);
    const page = await ctx.as.query(api.runs.listByBatchPaged, {
      batchId: ctx.batchId,
      paginationOpts: { numItems: 5, cursor: null },
    });
    // This is the bug the rollup exists to kill: counting the loaded rows
    // would report 5 runs for a 12-run batch.
    expect(page.page).toHaveLength(5);
    expect((await progress(ctx)).total).toBe(12);
  });
});

describe("batchProgress backfill migration", () => {
  test("rebuilds a rollup that drifted, and is idempotent", async () => {
    const ctx = await setup();
    const finished = await newRun(ctx);
    const failed = await newRun(ctx);
    await newRun(ctx); // stays pending
    await ctx.as.mutation(api.runs.updateStatus, {
      runId: finished,
      status: RUN_STATUS.FINISHED,
      converged: true,
      gibbsEh: -1,
      lastEnergy: -76,
      wallclockSec: 30,
      nprocs: 2,
      finishedAt: 1_700_000_000_000,
    });
    await ctx.as.mutation(api.runs.updateStatus, {
      runId: failed,
      status: RUN_STATUS.FAILED,
      errorClass: ERROR_CLASS.INPUT_ERROR,
    });
    const healthy = await progress(ctx);

    // Corrupt the rollup the way a lost write would.
    await ctx.t.run(async (runCtx) => {
      const row = await runCtx.db
        .query("batchProgress")
        .withIndex("by_batch", (q) => q.eq("batchId", ctx.batchId))
        .first();
      if (!row) throw new Error("no rollup to corrupt");
      await runCtx.db.patch(row._id, {
        total: 999,
        finished: 0,
        failed: 0,
        pending: 0,
        energyCount: 0,
        energySumEh: 0,
        minEnergyEh: undefined,
        failureCounts: { bogus: 7 },
      });
    });

    vi.useFakeTimers();
    await ctx.as.mutation(api.migrations.startBatchProgressBackfillIfNeeded, {});
    await ctx.t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();

    const rebuilt = await progress(ctx);
    expect(rebuilt).toMatchObject({
      total: healthy.total,
      pending: healthy.pending,
      finished: healthy.finished,
      failed: healthy.failed,
      converged: healthy.converged,
      energyCount: healthy.energyCount,
      energySumEh: healthy.energySumEh,
      minEnergyEh: healthy.minEnergyEh,
      wallclockSumSec: healthy.wallclockSumSec,
      coreSecondsSum: healthy.coreSecondsSum,
    });
    expect(rebuilt.failureCounts).toEqual(healthy.failureCounts);
  });

  test("a second kick is a no-op once the backfill is done", async () => {
    const ctx = await setup();
    vi.useFakeTimers();
    expect(
      await ctx.as.mutation(api.migrations.startBatchProgressBackfillIfNeeded, {}),
    ).toEqual({ status: "started" });
    await ctx.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(
      await ctx.as.mutation(api.migrations.startBatchProgressBackfillIfNeeded, {}),
    ).toEqual({ status: "idle" });
    vi.useRealTimers();
  });

  test("the backfill chain is reachable as internal functions", async () => {
    const ctx = await setup();
    await newRun(ctx);
    await ctx.t.mutation(internal.migrations.backfillNextBatch, {
      afterCreationTime: 0,
    });
    // One step consumes one batch; its rollup is rewritten from the runs.
    vi.useFakeTimers();
    await ctx.t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
    expect(await progress(ctx)).toMatchObject({ total: 1, pending: 1 });
  });
});
