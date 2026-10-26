import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

// The migrationState table is keyed, so it can host more than one migration —
// but every helper used to be inlined in migrations.ts around a single
// module-level key. These helpers make a second migration a matter of adding a
// key here, not of copying the race-guarded bootstrap logic.

export const MIGRATION_KEY = {
  /** Legacy chunked artifact bodies → Convex file storage. */
  CHUNKED_TO_STORAGE: "chunkedToStorage",
  /** Rebuild the batchProgress rollups from the runs table. */
  BATCH_PROGRESS_BACKFILL: "batchProgressBackfill",
  /** Rebuild the experimentProgress rollups from the runs table. */
  EXPERIMENT_PROGRESS_BACKFILL: "experimentProgressBackfill",
} as const;

export type MigrationKey = (typeof MIGRATION_KEY)[keyof typeof MIGRATION_KEY];

/** What a bootstrap kick reports back to the UI. */
export const MIGRATION_KICK = {
  /** Nothing to do: already done, already running, or no work found. */
  IDLE: "idle",
  /** A chain was scheduled by this call. */
  STARTED: "started",
} as const;

export type MigrationKickResult = {
  status: (typeof MIGRATION_KICK)[keyof typeof MIGRATION_KICK];
};

/**
 * How long a `running` migration may go without a heartbeat before a kick
 * treats its chain as dead and starts a new one.
 *
 * Every chain step stamps the heartbeat (throttled to HEARTBEAT_GRANULARITY_MS)
 * and steps follow each other within seconds, so a quiet half hour means the
 * chain died — a step threw past its retries, or a deploy dropped a job — and
 * without this the `running` flag would block every future kick forever.
 * Re-kicking a chain that is in fact still alive is harmless by construction:
 * the backfills REPLACE each rollup (idempotent) and the chunk migration's
 * attach is race-guarded.
 */
export const MIGRATION_STALE_MS = 30 * 60 * 1000;

/** Minimum gap between two heartbeat writes, so a fast chain does not write
 *  the state row on every step. Far below MIGRATION_STALE_MS. */
const HEARTBEAT_GRANULARITY_MS = 60 * 1000;

/** Rows one key can have: normally one, a few after a startup race. */
const MAX_STATE_ROWS_PER_KEY = 16;

// getOrCreateState returns the singleton row for one migration, creating it on
// first call.
//
// .first() (not .unique()): two clients can bootstrap at once and briefly
// insert duplicate rows. .unique() would throw on that and wedge every future
// startup; .first() picks one and the migration still runs correctly, provided
// the migration's own writes are race-guarded.
export async function getOrCreateState(
  ctx: MutationCtx,
  key: MigrationKey,
): Promise<Doc<"migrationState">> {
  const existing = await ctx.db
    .query("migrationState")
    .withIndex("by_key", (q) => q.eq("key", key))
    .first();
  if (existing) return existing;
  const id = await ctx.db.insert("migrationState", {
    key,
    running: false,
    done: false,
  });
  const created = await ctx.db.get(id);
  if (!created) throw new Error(`migrationState row for ${key} vanished on insert`);
  return created;
}

async function stateRows(
  ctx: MutationCtx,
  key: MigrationKey,
): Promise<Doc<"migrationState">[]> {
  return await ctx.db
    .query("migrationState")
    .withIndex("by_key", (q) => q.eq("key", key))
    .take(MAX_STATE_ROWS_PER_KEY);
}

// markDone clears `running` and sets `done` on *every* row for the key: a
// startup race can leave more than one, and marking them all keeps later
// startups a clean no-op regardless of which one a reader picks.
export async function markDone(ctx: MutationCtx, key: MigrationKey): Promise<void> {
  for (const state of await stateRows(ctx, key)) {
    await ctx.db.patch(state._id, { running: false, done: true });
  }
}

/** Whether a running migration's chain has gone quiet long enough to be
 *  presumed dead. A row with no heartbeat at all predates stale recovery and
 *  can only have been left `running` by a chain that never stamped one. */
export function isStale(state: Doc<"migrationState">, now: number): boolean {
  if (!state.running) return false;
  return (
    state.heartbeatAt === undefined ||
    now - state.heartbeatAt > MIGRATION_STALE_MS
  );
}

/** touchHeartbeat is called by every chain step: proof of life for isStale.
 *  Throttled, and never touches a finished migration. */
export async function touchHeartbeat(
  ctx: MutationCtx,
  key: MigrationKey,
): Promise<void> {
  const now = Date.now();
  for (const state of await stateRows(ctx, key)) {
    if (state.done) continue;
    if (
      state.heartbeatAt !== undefined &&
      now - state.heartbeatAt < HEARTBEAT_GRANULARITY_MS
    ) {
      continue;
    }
    await ctx.db.patch(state._id, { heartbeatAt: now });
  }
}

/**
 * kickMigration is the shared body of the bootstrap entry points: start the
 * chain unless the migration is done or already (and still visibly) running.
 *
 * `hasWork`, when given, is asked before starting; a migration with nothing to
 * do is marked done on the spot so later kicks short-circuit. `start`
 * schedules the chain's first step. Callers authorize BEFORE calling this —
 * the gate stays in each registered handler, where the static authz coverage
 * check can see it.
 */
export async function kickMigration(
  ctx: MutationCtx,
  key: MigrationKey,
  start: () => Promise<unknown>,
  hasWork?: () => Promise<boolean>,
): Promise<MigrationKickResult> {
  const state = await getOrCreateState(ctx, key);
  const now = Date.now();
  if (state.done) return { status: MIGRATION_KICK.IDLE };
  if (state.running && !isStale(state, now)) {
    return { status: MIGRATION_KICK.IDLE };
  }
  if (state.running) {
    console.warn(
      `migration ${key}: running flag set but no heartbeat since ${
        state.heartbeatAt === undefined
          ? "ever"
          : new Date(state.heartbeatAt).toISOString()
      }; presuming the chain dead and re-kicking it`,
    );
  }
  if (hasWork && !(await hasWork())) {
    await markDone(ctx, key);
    return { status: MIGRATION_KICK.IDLE };
  }
  await ctx.db.patch(state._id, { running: true, heartbeatAt: now });
  await start();
  return { status: MIGRATION_KICK.STARTED };
}
