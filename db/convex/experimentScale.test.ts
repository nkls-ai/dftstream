/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema, { RUN_STATUS } from "./schema";
import type { Id } from "./_generated/dataModel";
import { recordRunChange } from "./lib/batchProgressWriter";
import { EXPERIMENT_ROLLUP_READ_CAP } from "./lib/experimentProgressWriter";
import {
  OPS_PER_ROW,
  ROW_BYTES,
  STEP_BYTE_BUDGET,
  StepBudget,
  TRANSACTION_OP_LIMIT,
  TRANSACTION_READ_BYTE_LIMIT,
} from "./lib/stepBudget";

const modules = import.meta.glob("./**/*.ts");

// Scale cover for the two failures that only appear once an experiment gets
// large:
//
//   1. experiments.remove's cascade blew Convex's per-transaction operation
//      budget — it read up to 1,000 batches with their rollups, every pathway
//      via an unbounded collect(), and 100 runs, then scheduled one
//      self-rescheduling cleanup chain per run. The steps below assert that a
//      single step is now a bounded slice, that the chain still deletes
//      everything, and that a step which cannot finish reschedules instead of
//      giving up.
//   2. experiments.listWithSummary read up to 500 RUN documents per experiment
//      per page, which blew the per-query read budget on one large experiment
//      (the index then rendered skeletons forever) and reported a truncated
//      "500+" for anything past the cap. It now reads a rollup, so the numbers
//      are exact and the cost does not depend on the run count at all.
//
// The per-transaction budget itself is not enforced by convex-test, so these
// tests pin the two things that are observable: the SLICE SIZES (a step must
// not try to do everything at once) and the RESULTS (exact counts, nothing left
// behind).

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
  return { t, as, organizationId, experimentId };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

// seedRuns inserts runs the way runs.create does — the row plus the rollup
// delta in one transaction — without paying for argument validation and
// authorization on every one of several hundred rows.
async function seedRuns(
  ctx: Ctx,
  count: number,
  overrides: {
    status?: (typeof RUN_STATUS)[keyof typeof RUN_STATUS];
    functional?: string;
    basis?: string;
    runTypes?: string[];
    batchId?: Id<"batches">;
    name?: string;
  } = {},
): Promise<Id<"runs">[]> {
  return await ctx.t.run(async (mctx) => {
    const ids: Id<"runs">[] = [];
    for (let i = 0; i < count; i++) {
      const row = {
        experimentId: ctx.experimentId,
        status: overrides.status ?? RUN_STATUS.PENDING,
        startedAt: 1_700_000_000_000 + i,
        functional: overrides.functional ?? "B3LYP",
        basis: overrides.basis ?? "def2-SVP",
        runTypes: overrides.runTypes ?? ["Opt"],
        batchId: overrides.batchId,
        name: overrides.name,
      };
      ids.push(await mctx.db.insert("runs", row));
      await recordRunChange(mctx, null, row);
    }
    return ids;
  });
}

type ChildCounts = {
  events?: number;
  logs?: number;
  metrics?: number;
  geometries?: number;
  sysSamples?: number;
  frequencies?: number;
  excitedStates?: number;
  nmrShields?: number;
  artifacts?: number;
  chunksPerArtifact?: number;
};

async function seedChildren(
  ctx: Ctx,
  runIds: Id<"runs">[],
  counts: ChildCounts,
): Promise<void> {
  await ctx.t.run(async (mctx) => {
    for (const runId of runIds) {
      for (let i = 0; i < (counts.events ?? 0); i++) {
        await mctx.db.insert("events", { runId, seq: i, ts: i, kind: "scf", payload: {} });
      }
      for (let i = 0; i < (counts.logs ?? 0); i++) {
        await mctx.db.insert("logs", { runId, ts: i, level: "info", message: `l${i}` });
      }
      for (let i = 0; i < (counts.metrics ?? 0); i++) {
        await mctx.db.insert("metrics", { runId, key: "energy", ts: i, value: -76 });
      }
      for (let i = 0; i < (counts.geometries ?? 0); i++) {
        await mctx.db.insert("geometries", { runId, cycle: i, ts: i, xyz: "H 0 0 0" });
      }
      for (let i = 0; i < (counts.sysSamples ?? 0); i++) {
        await mctx.db.insert("sysSamples", { runId, ts: i, cpuPct: 50, rssMb: 10, threads: 4 });
      }
      for (let i = 0; i < (counts.frequencies ?? 0); i++) {
        await mctx.db.insert("frequencies", {
          runId,
          idx: i,
          wavenumber: 100 + i,
          imaginary: false,
        });
      }
      for (let i = 0; i < (counts.excitedStates ?? 0); i++) {
        await mctx.db.insert("excitedStates", {
          runId,
          idx: i,
          energyEv: 1,
          wavelengthNm: 400,
          oscStrength: 0.1,
        });
      }
      for (let i = 0; i < (counts.nmrShields ?? 0); i++) {
        await mctx.db.insert("nmrShields", {
          runId,
          atomIdx: i,
          element: "H",
          isotropic: 30,
          anisotropy: 1,
        });
      }
      for (let i = 0; i < (counts.artifacts ?? 0); i++) {
        const artifactId = await mctx.db.insert("artifacts", {
          runId,
          name: `out${i}.txt`,
          path: `/tmp/out${i}.txt`,
          kind: "output",
          sizeBytes: 10,
          mtime: 0,
          contentText: "head",
          chunked: true,
          numChunks: counts.chunksPerArtifact ?? 0,
        });
        for (let c = 0; c < (counts.chunksPerArtifact ?? 0); c++) {
          await mctx.db.insert("artifactChunks", { artifactId, idx: c, text: "body" });
        }
      }
    }
  });
}

const COUNTED_TABLES = [
  "runs",
  "events",
  "logs",
  "metrics",
  "geometries",
  "sysSamples",
  "frequencies",
  "excitedStates",
  "nmrShields",
  "artifacts",
  "artifactChunks",
  "batches",
  "batchProgress",
  "experimentProgress",
  "pathways",
  "experiments",
] as const;

type TableCounts = Record<(typeof COUNTED_TABLES)[number], number>;

async function countRows(ctx: Ctx): Promise<TableCounts> {
  return await ctx.t.run(async (mctx) => {
    const out = {} as TableCounts;
    for (const table of COUNTED_TABLES) {
      out[table] = (await mctx.db.query(table).collect()).length;
    }
    return out;
  });
}

async function summaries(ctx: Ctx) {
  const page = await ctx.as.query(api.experiments.listWithSummary, {
    paginationOpts: { numItems: 50, cursor: null },
    organizationId: ctx.organizationId,
  });
  return page.page;
}

// The cascade deliberately spaces its steps 50 ms apart to leave room for
// concurrent UI queries, so the whole file runs on fake timers: convex-test can
// only drive a scheduled job whose timer was created while they were installed.
// drain then runs every queued step (and every compaction, and the migration
// chains) to completion.
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function drain(ctx: Ctx): Promise<void> {
  await ctx.t.finishAllScheduledFunctions(vi.runAllTimers);
}

describe("experiment cleanup stays inside one transaction's budget", () => {
  test("a runs step deletes a bounded slice, not every run it can see", async () => {
    const ctx = await setup();
    await seedRuns(ctx, 200);

    // One step, called directly. The old cascade took 100 runs AND scheduled
    // 100 follow-up chains in this single transaction; the new one takes a
    // slice small enough that its reads (run documents inline their whole ORCA
    // input) also stay inside the byte budget.
    await ctx.t.mutation(internal.experiments._cleanupExperimentRunsStep, {
      experimentId: ctx.experimentId,
    });
    const after = await countRows(ctx);
    expect(after.runs).toBeGreaterThanOrEqual(100);
    expect(after.runs).toBeLessThan(200);
  });

  test("a child-cleanup step drains what it can afford and reschedules the rest", async () => {
    const ctx = await setup();
    const [runId] = await seedRuns(ctx, 1);
    // More child rows than one transaction's operation budget allows.
    await seedChildren(ctx, [runId!], { events: 2000 });

    await ctx.t.mutation(internal.experiments._cleanupRunChildrenStep, {
      runIds: [runId!],
    });
    const midway = await countRows(ctx);
    expect(midway.events).toBeGreaterThan(0);
    expect(midway.events).toBeLessThan(2000);

    // The step scheduled its own continuation rather than throwing or
    // abandoning the rest.
    await drain(ctx);
    expect((await countRows(ctx)).events).toBe(0);
  });

  test("the cascade deletes every row of a large experiment", async () => {
    const ctx = await setup();
    const batchIds: Id<"batches">[] = [];
    for (const name of ["a", "b", "c"]) {
      batchIds.push(
        await ctx.as.mutation(api.experiments.createBatch, {
          experimentId: ctx.experimentId,
          name,
        }),
      );
    }
    const runIds: Id<"runs">[] = [];
    for (const batchId of batchIds) {
      runIds.push(...(await seedRuns(ctx, 12, { batchId })));
    }
    await seedChildren(ctx, runIds, {
      events: 40,
      logs: 20,
      metrics: 30,
      geometries: 8,
      sysSamples: 12,
      frequencies: 24,
      excitedStates: 6,
      nmrShields: 10,
      artifacts: 2,
      chunksPerArtifact: 3,
    });
    await ctx.as.mutation(api.pathways.create, {
      experimentId: ctx.experimentId,
      name: "path",
      points: [{ runId: runIds[0]!, role: "reactant", order: 0 }],
    });

    const before = await countRows(ctx);
    expect(before.runs).toBe(36);
    expect(before.events).toBe(36 * 40);
    expect(before.artifactChunks).toBe(36 * 2 * 3);

    await ctx.as.mutation(api.experiments.remove, {
      experimentId: ctx.experimentId,
    });
    await drain(ctx);

    const after = await countRows(ctx);
    for (const table of COUNTED_TABLES) {
      expect([table, after[table]]).toEqual([table, 0]);
    }
  });

  test("deleting one run drains only that run's children", async () => {
    const ctx = await setup();
    const [keep, drop] = await seedRuns(ctx, 2);
    await seedChildren(ctx, [keep!, drop!], {
      events: 30,
      artifacts: 1,
      chunksPerArtifact: 2,
    });

    await ctx.as.mutation(api.experiments.removeRunNow, { runId: drop! });
    await drain(ctx);

    const after = await countRows(ctx);
    expect(after.runs).toBe(1);
    expect(after.events).toBe(30);
    expect(after.artifacts).toBe(1);
    expect(after.artifactChunks).toBe(2);
    // The run's contribution left the experiment rollup with it.
    expect((await summaries(ctx))[0]).toMatchObject({ runCount: 1 });
  });

  test("the pre-rewrite _cleanupRunStep entry point still drains a run", async () => {
    const ctx = await setup();
    const [runId] = await seedRuns(ctx, 1);
    await seedChildren(ctx, [runId!], { events: 10, metrics: 10 });
    await ctx.t.run(async (mctx) => mctx.db.delete(runId!));

    // Jobs queued by the old cascade survive a deploy; they must not strand
    // their run's children.
    await ctx.t.mutation(internal.experiments._cleanupRunStep, { runId: runId! });
    await drain(ctx);
    const after = await countRows(ctx);
    expect(after.events).toBe(0);
    expect(after.metrics).toBe(0);
  });
});

describe("listWithSummary does not scan runs", () => {
  test("counts are exact past the old 500-run read cap", async () => {
    const ctx = await setup();
    await seedRuns(ctx, 300, { status: RUN_STATUS.FINISHED });
    await seedRuns(ctx, 180, { status: RUN_STATUS.FAILED, functional: "PBE0" });
    await seedRuns(ctx, 40, { status: RUN_STATUS.RUNNING });
    await seedRuns(ctx, 20, { status: RUN_STATUS.PENDING });
    // Fold the appended deltas, as the scheduler does in a live deployment.
    await drain(ctx);

    const [summary] = await summaries(ctx);
    // The old implementation read runs .take(500) and reported "500+".
    expect(summary).toMatchObject({
      runCount: 540,
      runCountCapped: false,
      summaryPending: false,
      finished: 300,
      failed: 180,
      running: 60,
      topFunctional: "B3LYP",
      topBasis: "def2-SVP",
      topRunType: "Opt",
    });
  });

  test("the rollup read is bounded no matter how many runs exist", async () => {
    const ctx = await setup();
    await seedRuns(ctx, 400);
    await drain(ctx);
    const rollupRows = await ctx.t.run(
      async (mctx) => (await mctx.db.query("experimentProgress").collect()).length,
    );
    // Compaction folds the appended deltas back down, so a summary read costs a
    // handful of tiny rows per experiment — never one document per run.
    expect(rollupRows).toBeLessThanOrEqual(EXPERIMENT_ROLLUP_READ_CAP);
    expect((await summaries(ctx))[0]).toMatchObject({
      runCount: 400,
      runCountCapped: false,
    });
  });

  test("the real run mutations keep the rollup exact", async () => {
    const ctx = await setup();
    const batchId = await ctx.as.mutation(api.experiments.createBatch, {
      experimentId: ctx.experimentId,
      name: "conformers",
    });
    const runId = await ctx.as.mutation(api.runs.create, {
      experimentId: ctx.experimentId,
      batchId,
      name: "conf-1",
      functional: "B3LYP",
      basis: "def2-SVP",
      runTypes: ["Opt"],
    });
    expect((await summaries(ctx))[0]).toMatchObject({
      runCount: 1,
      running: 1,
      finished: 0,
      latestRunName: "conf-1",
      latestStatus: RUN_STATUS.PENDING,
      latestRunId: runId,
    });

    await ctx.as.mutation(api.runs.updateStatus, {
      runId,
      status: RUN_STATUS.RUNNING,
    });
    await ctx.as.mutation(api.runs.updateStatus, {
      runId,
      status: RUN_STATUS.FINISHED,
      finishedAt: 1_700_000_000_500,
      lastEnergy: -76.4,
    });
    // A result-only patch repeats the status; it must not double-count.
    await ctx.as.mutation(api.runs.updateStatus, { runId, gibbsEh: -76.1 });
    expect((await summaries(ctx))[0]).toMatchObject({
      runCount: 1,
      running: 0,
      finished: 1,
      lastActivity: 1_700_000_000_500,
    });

    // A rename must show up in the card, which is why the latest run is read
    // rather than cached in the rollup.
    await ctx.as.mutation(api.runs.rename, { runId, name: "conf-1-opt" });
    expect((await summaries(ctx))[0]).toMatchObject({
      latestRunName: "conf-1-opt",
    });
  });

  test("a brand-new experiment reads as zero runs, not as pending", async () => {
    const ctx = await setup();
    expect((await summaries(ctx))[0]).toMatchObject({
      runCount: 0,
      summaryPending: false,
      lastActivity: expect.any(Number),
    });
  });

  test("an experiment with no rollup reports pending, and the backfill fixes it", async () => {
    const ctx = await setup();
    await seedRuns(ctx, 120, { status: RUN_STATUS.FINISHED });
    await seedRuns(ctx, 30, { status: RUN_STATUS.FAILED, functional: "PBE0" });
    await drain(ctx);

    // An experiment that predates the rollup: drop every row it has.
    await ctx.t.run(async (mctx) => {
      for (const row of await mctx.db.query("experimentProgress").collect()) {
        await mctx.db.delete(row._id);
      }
    });
    expect((await summaries(ctx))[0]).toMatchObject({
      summaryPending: true,
      runCount: 0,
    });

    await ctx.as.mutation(
      api.migrations.startExperimentProgressBackfillIfNeeded,
      {},
    );
    await drain(ctx);

    expect((await summaries(ctx))[0]).toMatchObject({
      summaryPending: false,
      runCount: 150,
      finished: 120,
      failed: 30,
      topFunctional: "B3LYP",
    });
  });

  test("re-running the backfill reproduces the same numbers", async () => {
    const ctx = await setup();
    await seedRuns(ctx, 90, { status: RUN_STATUS.FINISHED });
    await drain(ctx);

    await ctx.t.run(async (mctx) => {
      for (const row of await mctx.db.query("migrationState").collect()) {
        await mctx.db.patch(row._id, { running: false, done: false });
      }
    });
    await ctx.as.mutation(
      api.migrations.startExperimentProgressBackfillIfNeeded,
      {},
    );
    await drain(ctx);

    expect((await summaries(ctx))[0]).toMatchObject({
      runCount: 90,
      finished: 90,
      summaryPending: false,
    });
  });
});

// The arithmetic itself, since convex-test does not enforce Convex's ceilings:
// what a step is ALLOWED to spend has to stay under them by construction.
describe("per-transaction budget arithmetic", () => {
  test("a step cannot spend more than half the operation ceiling", () => {
    const budget = new StepBudget();
    let rows = 0;
    for (;;) {
      // The cheapest rows there are, i.e. the most a step could ever delete.
      const n = budget.rowsAffordable("metrics", 256);
      if (n === 0) break;
      budget.spendRows("metrics", n);
      rows += n;
    }
    expect(rows * OPS_PER_ROW).toBeLessThanOrEqual(TRANSACTION_OP_LIMIT / 2);
  });

  test("a step cannot read more than half the byte ceiling", () => {
    expect(STEP_BYTE_BUDGET * 2).toBeLessThanOrEqual(TRANSACTION_READ_BYTE_LIMIT);
    const budget = new StepBudget();
    let bytes = 0;
    for (;;) {
      // The heaviest rows there are.
      const n = budget.rowsAffordable("artifactChunks", 4);
      if (n === 0) break;
      budget.spendRows("artifactChunks", n);
      bytes += n * ROW_BYTES.artifactChunks;
    }
    expect(bytes).toBeLessThanOrEqual(STEP_BYTE_BUDGET);
  });

  test("a fresh budget affords at least one row of every table, so a step always progresses", () => {
    for (const table of Object.keys(ROW_BYTES) as (keyof typeof ROW_BYTES)[]) {
      expect([table, new StepBudget().rowsAffordable(table, 1)]).toEqual([
        table,
        1,
      ]);
    }
  });

  test("the pre-rewrite slice sizes did not fit, which is the bug", () => {
    // What the old deleteExperimentRunsBatch could spend in ONE transaction:
    //   batches:   .take(1000)            → 1000 reads + 1000 deletes
    //   per batch: removeProgress()       → up to 16 passes x 64 rows, each a
    //                                       read plus a delete
    //   pathways:  .collect()             → unbounded, counted here as 0
    //   runs:      .take(100)             → 100 reads + 100 deletes
    //              + one scheduler call per run
    const batchOps = 1000 * OPS_PER_ROW;
    const rollupOpsPerBatch = 16 * 64 * OPS_PER_ROW;
    const runOps = 100 * OPS_PER_ROW + 100;
    expect(batchOps + rollupOpsPerBatch + runOps).toBeGreaterThan(
      TRANSACTION_OP_LIMIT,
    );
    // A single batch's rollup drain could exhaust half the ceiling on its own.
    expect(rollupOpsPerBatch).toBeGreaterThanOrEqual(TRANSACTION_OP_LIMIT / 2);
    // And the old per-run child step read 200 rows from a table whose rows are
    // not small: 200 geometries is far past the byte budget a step may use.
    expect(200 * ROW_BYTES.geometries).toBeGreaterThan(STEP_BYTE_BUDGET);
  });
});
