import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
} from "./_generated/server";
import { internal } from "./_generated/api";
import {
  MIGRATION_KEY,
  kickMigration,
  type MigrationKickResult,
  markDone,
  touchHeartbeat,
} from "./lib/migrationState";
import { batchProgressFields, experimentProgressFields } from "./schema";
import {
  emptyExperimentProgress,
  experimentDelta,
  sumExperimentProgress,
  type ExperimentProgressValues,
} from "./lib/experimentSummary";
import { replaceExperimentProgress } from "./lib/experimentProgressWriter";
import {
  applyContribution,
  emptyProgress,
  runContribution,
  type ProgressValues,
} from "./lib/batchSummary";
import { replaceProgress } from "./lib/batchProgressWriter";
import { gateAnyMembership } from "./authz";

// Every migration entry point below is kicked from app bootstrap, so it is a
// public mutation that schedules deployment-wide work — not something an
// anonymous caller should be able to start. The guards are self-limiting (they
// short-circuit on the `done`/`running` flags), but a stranger racing the
// bootstrap still costs the deployment scheduler time. Membership, not merely
// being signed in, is the bar: signup is self-service. The check is written out
// at each entry point rather than wrapped in a helper because authzCoverage's
// static check proves a gate helper is NAMED in the handler — a wrapper would
// hide exactly what that test exists to see. No-op when auth is off, so a
// single-user local install still migrates itself.

// One-shot migration of legacy chunked artifacts (body split across the
// artifactChunks table) into Convex file storage (a single blob referenced by
// storageId). It is kicked once at app startup via startIfNeeded and self-idles
// the moment no old-format rows remain. The legacy chunk read paths stay in
// place as a fallback for anything not yet converted.
//
// ctx.storage.store() is action-only and actions can't touch ctx.db, so the
// action drives bounded runQuery/runMutation calls and chains via the
// scheduler — the same cascade shape used in experiments.ts.
//
// Every entry point shares lib/migrationState.kickMigration: done → idle,
// running with a recent heartbeat → idle, running but silent for
// MIGRATION_STALE_MS → the chain is presumed dead and re-kicked. Each chain
// step stamps the heartbeat (touchHeartbeat) as proof of life.

const CHUNK_MIGRATION = MIGRATION_KEY.CHUNKED_TO_STORAGE;
// 8 × ~512 KB ≈ 4 MiB scanned per query — safely under the 16 MiB budget.
const CHUNK_BATCH = 8;

// --- internal queries/mutations the action drives ----------------------------

// nextChunkedArtifact returns one not-yet-migrated chunked artifact (chunked is
// cleared once migrated, so this naturally skips converted rows), or null.
export const nextChunkedArtifact = internalQuery({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query("artifacts")
      .withIndex("by_chunked", (q) => q.eq("chunked", true))
      .first();
    if (!row) return null;
    return { artifactId: row._id, contentText: row.contentText ?? "" };
  },
});

// getChunkBatch returns up to CHUNK_BATCH chunks with idx > afterIdx, in order.
export const getChunkBatch = internalQuery({
  args: { artifactId: v.id("artifacts"), afterIdx: v.number() },
  handler: async (ctx, { artifactId, afterIdx }) => {
    const chunks = await ctx.db
      .query("artifactChunks")
      .withIndex("by_artifact_idx", (q) =>
        q.eq("artifactId", artifactId).gt("idx", afterIdx),
      )
      .take(CHUNK_BATCH);
    return chunks.map((c) => ({ idx: c.idx, text: c.text }));
  },
});

// attachStorage points the artifact at its new blob and clears the legacy
// chunk flags. Guarded so a re-entrant chain can't double-attach.
export const attachStorage = internalMutation({
  args: { artifactId: v.id("artifacts"), storageId: v.id("_storage") },
  handler: async (ctx, { artifactId, storageId }) => {
    await touchHeartbeat(ctx, CHUNK_MIGRATION);
    const row = await ctx.db.get(artifactId);
    if (!row) return { ok: false as const };
    if (row.storageId) return { ok: false as const }; // already migrated
    await ctx.db.patch(artifactId, {
      storageId,
      chunked: undefined,
      numChunks: undefined,
    });
    return { ok: true as const };
  },
});

// deleteChunkBatch removes up to CHUNK_BATCH chunk rows for an artifact and
// reports whether more remain, so the action can drain them without any single
// mutation scanning past the read budget.
export const deleteChunkBatch = internalMutation({
  args: { artifactId: v.id("artifacts") },
  handler: async (ctx, { artifactId }) => {
    const chunks = await ctx.db
      .query("artifactChunks")
      .withIndex("by_artifact_idx", (q) => q.eq("artifactId", artifactId))
      .take(CHUNK_BATCH);
    for (const c of chunks) await ctx.db.delete(c._id);
    return { more: chunks.length === CHUNK_BATCH };
  },
});

// finishMigration marks the singleton done so future startups are a no-op.
export const finishMigration = internalMutation({
  args: {},
  handler: async (ctx) => {
    await markDone(ctx, CHUNK_MIGRATION);
  },
});

// --- the chained migration action --------------------------------------------

export const migrateChunkedStep = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    const next = await ctx.runQuery(internal.migrations.nextChunkedArtifact, {});
    if (!next) {
      await ctx.runMutation(internal.migrations.finishMigration, {});
      return;
    }

    // Reassemble the body: head preview first, then chunks in idx order.
    const parts: string[] = [];
    if (next.contentText) parts.push(next.contentText);
    let afterIdx = -1;
    for (;;) {
      const batch = await ctx.runQuery(internal.migrations.getChunkBatch, {
        artifactId: next.artifactId,
        afterIdx,
      });
      if (batch.length === 0) break;
      for (const c of batch) {
        parts.push(c.text);
        afterIdx = c.idx;
      }
      if (batch.length < CHUNK_BATCH) break;
    }

    const storageId = await ctx.storage.store(
      new Blob(parts, { type: "text/plain" }),
    );
    const attached = await ctx.runMutation(internal.migrations.attachStorage, {
      artifactId: next.artifactId,
      storageId,
    });
    if (!attached.ok) {
      // Lost a race (already migrated elsewhere) — drop our orphan blob.
      await ctx.storage.delete(storageId);
    } else {
      let more = true;
      while (more) {
        const res = await ctx.runMutation(internal.migrations.deleteChunkBatch, {
          artifactId: next.artifactId,
        });
        more = res.more;
      }
    }

    // Continue with the next artifact on a fresh step.
    await ctx.scheduler.runAfter(0, internal.migrations.migrateChunkedStep, {});
  },
});

// --- public startup entry point ----------------------------------------------

// startIfNeeded is called once on app bootstrap. It exits immediately when the
// data is already in the new format (or a migration is in flight) and only
// kicks the conversion when real chunked rows still exist.
export const startIfNeeded = mutation({
  args: {},
  handler: async (ctx): Promise<MigrationKickResult> => {
    await gateAnyMembership(ctx);
    // attachStorage is itself race-guarded, so a duplicate state row (or a
    // re-kicked chain racing a slow survivor) is harmless.
    return await kickMigration(
      ctx,
      CHUNK_MIGRATION,
      () => ctx.scheduler.runAfter(0, internal.migrations.migrateChunkedStep, {}),
      async () =>
        (await ctx.db
          .query("artifacts")
          .withIndex("by_chunked", (q) => q.eq("chunked", true))
          .first()) !== null,
    );
  },
});

// =============================================================================
// batchProgress backfill
// =============================================================================
//
// Rebuilds the denormalized per-batch rollups from the runs table, for batches
// that filled up before the rollup existed. Unlike the chunk migration this
// needs no file storage, so it is a plain chain of internalMutations — each
// step is one small transaction that reschedules itself.
//
// Resumable: all of its state is the scheduler payload (which batch, how far
// into that batch's runs, and the partial tally so far), so a step that dies
// resumes by re-kicking the migration.
// Idempotent: a batch's rollup is only written once its runs are fully scanned,
// and the write REPLACES the rows rather than adding to them. Re-running the
// whole migration therefore reproduces exactly the same numbers.
//
// The chain is two functions, not one, because Convex allows a single
// paginated query per function: one walks the batches, the other walks one
// batch's runs.

const PROGRESS_MIGRATION = MIGRATION_KEY.BATCH_PROGRESS_BACKFILL;
// Runs scanned per step. Run documents can hold an inlined inputText, so keep
// the slice well under the per-transaction read budget.
const BACKFILL_RUNS_PER_STEP = 200;

// The in-flight tally for the batch currently being rebuilt.
const backfillCursor = v.object({
  batchId: v.id("batches"),
  experimentId: v.id("experiments"),
  runCursor: v.union(v.string(), v.null()),
  acc: v.object(batchProgressFields),
});

// backfillNextBatch takes the batch created after `afterCreationTime` (via the
// built-in by_creation_time index — a plain .take(1), so this function's one
// pagination budget stays free for the runs walk) and hands it to
// backfillBatchRuns. No batch left means the migration is done.
export const backfillNextBatch = internalMutation({
  args: { afterCreationTime: v.number() },
  handler: async (ctx, { afterCreationTime }) => {
    await touchHeartbeat(ctx, PROGRESS_MIGRATION);
    const [batch] = await ctx.db
      .query("batches")
      .withIndex("by_creation_time", (q) => q.gt("_creationTime", afterCreationTime))
      .take(1);
    if (!batch) {
      await markDone(ctx, PROGRESS_MIGRATION);
      return;
    }
    await ctx.scheduler.runAfter(0, internal.migrations.backfillBatchRuns, {
      afterCreationTime: batch._creationTime,
      current: {
        batchId: batch._id,
        experimentId: batch.experimentId,
        runCursor: null,
        acc: emptyProgress(batch._id, batch.experimentId, Date.now()),
      },
    });
  },
});

// backfillBatchRuns folds one page of a batch's runs into the accumulator,
// then either continues through that batch or writes the finished rollup and
// moves on to the next batch.
export const backfillBatchRuns = internalMutation({
  args: { afterCreationTime: v.number(), current: backfillCursor },
  handler: async (ctx, { afterCreationTime, current }) => {
    await touchHeartbeat(ctx, PROGRESS_MIGRATION);
    const now = Date.now();
    const runPage = await ctx.db
      .query("runs")
      .withIndex("by_batch_started", (q) => q.eq("batchId", current.batchId))
      .paginate({ numItems: BACKFILL_RUNS_PER_STEP, cursor: current.runCursor });

    let acc: ProgressValues = current.acc;
    for (const run of runPage.page) {
      acc = applyContribution(acc, null, runContribution(run), now);
    }

    if (!runPage.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.backfillBatchRuns, {
        afterCreationTime,
        current: { ...current, runCursor: runPage.continueCursor, acc },
      });
      return;
    }

    if (!(await replaceProgress(ctx, acc))) {
      // Too many stale rollup rows to clear in one transaction. The attempt
      // deleted a slice of them and wrote nothing, so retrying the same step
      // converges instead of double-counting.
      await ctx.scheduler.runAfter(0, internal.migrations.backfillBatchRuns, {
        afterCreationTime,
        current: { ...current, acc },
      });
      return;
    }
    await ctx.scheduler.runAfter(0, internal.migrations.backfillNextBatch, {
      afterCreationTime,
    });
  },
});

// =============================================================================
// experimentProgress backfill
// =============================================================================
//
// The same chain one level up: rebuilds the per-experiment rollups that
// experiments.listWithSummary reads, for every experiment that filled up before
// that rollup existed. Until an experiment has been rebuilt the card reports
// its summary as pending rather than claiming it has no runs.
//
// Resumable and idempotent for the same reasons as the batch backfill: all
// state is the scheduler payload, and the rollup is REPLACED (never added to)
// once the experiment's runs have been fully scanned.

const EXPERIMENT_PROGRESS_MIGRATION = MIGRATION_KEY.EXPERIMENT_PROGRESS_BACKFILL;
// Runs scanned per step. Half the batch backfill's slice: run documents inline
// their ORCA input, and this walk has no batch filter narrowing it.
const EXPERIMENT_BACKFILL_RUNS_PER_STEP = 100;

const experimentBackfillCursor = v.object({
  experimentId: v.id("experiments"),
  runCursor: v.union(v.string(), v.null()),
  acc: v.object(experimentProgressFields),
});

// backfillNextExperiment takes the experiment created after
// `afterCreationTime` (a plain .take(1) via the built-in creation-time index,
// so this function's one pagination budget stays free for the runs walk) and
// hands it to backfillExperimentRuns.
export const backfillNextExperiment = internalMutation({
  args: { afterCreationTime: v.number() },
  handler: async (ctx, { afterCreationTime }) => {
    await touchHeartbeat(ctx, EXPERIMENT_PROGRESS_MIGRATION);
    const [experiment] = await ctx.db
      .query("experiments")
      .withIndex("by_creation_time", (q) =>
        q.gt("_creationTime", afterCreationTime),
      )
      .take(1);
    if (!experiment) {
      await markDone(ctx, EXPERIMENT_PROGRESS_MIGRATION);
      return;
    }
    await ctx.scheduler.runAfter(0, internal.migrations.backfillExperimentRuns, {
      afterCreationTime: experiment._creationTime,
      current: {
        experimentId: experiment._id,
        runCursor: null,
        acc: emptyExperimentProgress(experiment._id, Date.now()),
      },
    });
  },
});

// backfillExperimentRuns folds one page of an experiment's runs into the
// accumulator, then either continues through that experiment or writes the
// finished rollup and moves on to the next one.
export const backfillExperimentRuns = internalMutation({
  args: { afterCreationTime: v.number(), current: experimentBackfillCursor },
  handler: async (ctx, { afterCreationTime, current }) => {
    await touchHeartbeat(ctx, EXPERIMENT_PROGRESS_MIGRATION);
    const now = Date.now();
    const runPage = await ctx.db
      .query("runs")
      .withIndex("by_experiment_started", (q) =>
        q.eq("experimentId", current.experimentId),
      )
      .paginate({
        numItems: EXPERIMENT_BACKFILL_RUNS_PER_STEP,
        cursor: current.runCursor,
      });

    let acc: ExperimentProgressValues = current.acc;
    for (const run of runPage.page) {
      acc = sumExperimentProgress(
        current.experimentId,
        [acc, experimentDelta(current.experimentId, null, run, now)],
        now,
      );
    }

    if (!runPage.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.backfillExperimentRuns,
        {
          afterCreationTime,
          current: { ...current, runCursor: runPage.continueCursor, acc },
        },
      );
      return;
    }

    if (!(await replaceExperimentProgress(ctx, acc))) {
      // Too many stale rollup rows to clear in one transaction. The attempt
      // deleted a slice of them and wrote nothing, so retrying the same step
      // converges instead of double-counting.
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.backfillExperimentRuns,
        { afterCreationTime, current: { ...current, acc } },
      );
      return;
    }
    await ctx.scheduler.runAfter(0, internal.migrations.backfillNextExperiment, {
      afterCreationTime,
    });
  },
});

// startExperimentProgressBackfillIfNeeded is kicked once at app bootstrap
// alongside the other two. Unlike them it is not optional in practice: an
// experiment with no rollup shows no counts until this has run.
export const startExperimentProgressBackfillIfNeeded = mutation({
  args: {},
  handler: async (ctx): Promise<MigrationKickResult> => {
    await gateAnyMembership(ctx);
    return await kickMigration(ctx, EXPERIMENT_PROGRESS_MIGRATION, () =>
      ctx.scheduler.runAfter(0, internal.migrations.backfillNextExperiment, {
        // Every experiment has a positive _creationTime, so 0 starts at the first.
        afterCreationTime: 0,
      }),
    );
  },
});

// startBatchProgressBackfillIfNeeded is kicked once at app bootstrap alongside
// startIfNeeded. A deployment whose batches already carry rollups (every batch
// created since maintains its own) short-circuits on the `done` flag.
export const startBatchProgressBackfillIfNeeded = mutation({
  args: {},
  handler: async (ctx): Promise<MigrationKickResult> => {
    await gateAnyMembership(ctx);
    return await kickMigration(ctx, PROGRESS_MIGRATION, () =>
      ctx.scheduler.runAfter(0, internal.migrations.backfillNextBatch, {
        // Every batch has a positive _creationTime, so 0 starts from the first.
        afterCreationTime: 0,
      }),
    );
  },
});
