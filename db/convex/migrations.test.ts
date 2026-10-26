/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  MIGRATION_KEY,
  MIGRATION_KICK,
  MIGRATION_STALE_MS,
  type MigrationKey,
} from "./lib/migrationState";

const modules = import.meta.glob("./**/*.ts");

// The shared bootstrap kick (lib/migrationState.kickMigration) and its
// stale-chain recovery. The backfills' arithmetic is covered in
// batchProgress.test.ts / experimentScale.test.ts.

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function localDeployment() {
  // Single-user mode: the kick needs no identity, exactly as on a local
  // install.
  vi.stubEnv("DFTSTREAM_AUTH_REQUIRED", "0");
  return convexTest(schema, modules);
}

type Harness = ReturnType<typeof localDeployment>;

async function seedState(
  t: Harness,
  key: MigrationKey,
  state: { running: boolean; done: boolean; heartbeatAt?: number },
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("migrationState", { key, ...state });
  });
}

async function stateOf(t: Harness, key: MigrationKey) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("migrationState")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first(),
  );
}

describe("migration kicks", () => {
  test("a chain that is running and alive is left alone", async () => {
    const t = localDeployment();
    await seedState(t, MIGRATION_KEY.BATCH_PROGRESS_BACKFILL, {
      running: true,
      done: false,
      heartbeatAt: Date.now(),
    });
    expect(
      await t.mutation(api.migrations.startBatchProgressBackfillIfNeeded, {}),
    ).toEqual({ status: MIGRATION_KICK.IDLE });
  });

  test("a chain silent past the stale window is presumed dead and re-kicked", async () => {
    const t = localDeployment();
    await seedState(t, MIGRATION_KEY.BATCH_PROGRESS_BACKFILL, {
      running: true,
      done: false,
      heartbeatAt: Date.now() - MIGRATION_STALE_MS - 1,
    });
    vi.useFakeTimers();
    expect(
      await t.mutation(api.migrations.startBatchProgressBackfillIfNeeded, {}),
    ).toEqual({ status: MIGRATION_KICK.STARTED });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // The re-kicked chain ran to completion and marked the migration done.
    expect(await stateOf(t, MIGRATION_KEY.BATCH_PROGRESS_BACKFILL)).toMatchObject({
      running: false,
      done: true,
    });
  });

  test("a running flag left by a pre-heartbeat deployment is recoverable", async () => {
    // Rows written before heartbeatAt existed: `running: true` with no proof
    // of life used to block every future kick forever.
    const t = localDeployment();
    await seedState(t, MIGRATION_KEY.EXPERIMENT_PROGRESS_BACKFILL, {
      running: true,
      done: false,
    });
    vi.useFakeTimers();
    expect(
      await t.mutation(api.migrations.startExperimentProgressBackfillIfNeeded, {}),
    ).toEqual({ status: MIGRATION_KICK.STARTED });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(
      await stateOf(t, MIGRATION_KEY.EXPERIMENT_PROGRESS_BACKFILL),
    ).toMatchObject({ done: true, running: false });
  });

  test("a finished migration is never restarted, however old", async () => {
    const t = localDeployment();
    await seedState(t, MIGRATION_KEY.BATCH_PROGRESS_BACKFILL, {
      running: false,
      done: true,
      heartbeatAt: 1,
    });
    expect(
      await t.mutation(api.migrations.startBatchProgressBackfillIfNeeded, {}),
    ).toEqual({ status: MIGRATION_KICK.IDLE });
  });

  test("the chunk migration with nothing to convert is marked done on the spot", async () => {
    const t = localDeployment();
    expect(await t.mutation(api.migrations.startIfNeeded, {})).toEqual({
      status: MIGRATION_KICK.IDLE,
    });
    expect(await stateOf(t, MIGRATION_KEY.CHUNKED_TO_STORAGE)).toMatchObject({
      done: true,
      running: false,
    });
  });
});
