import { v } from "convex/values";
import { mutation, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  eventFields,
  logFields,
  metricFields,
  sysSampleFields,
} from "./schema";
import { appendRunChildren, type RunChildTable, type RunChildItem } from "./lib/runChildren";
import { authorizeExperimentWrite, gateRunWrite } from "./authz";
import { insertRun, runCreateArgs } from "./runs";

// Idempotency-guarded replay mutations for offline journals (wrapper spool
// mode — see wrapper/internal/spool and docs/COMPAT.md).
//
// `dftstream sync` replays a journal op by op and checkpoints progress in a
// client-side cursor file. If sync dies between a mutation's commit and the
// cursor write, the op is re-sent on the next run. The naturally idempotent
// mutations (ensure*, updateStatus, geometries:append, the setAll family,
// artifact upserts) absorb that; the blind-insert family (runs:create,
// *:appendMany) would duplicate rows. These variants close the gap: each
// takes a client-generated key and records it in `spoolMarkers` IN THE SAME
// TRANSACTION as the write, so a replayed key is recognized and skipped.
//
// Advertised as the additive "spool" feature in meta:version — a wrapper
// only calls these after probing for it.

/** Marker lookup. Keys are 64-bit-random-prefixed and unguessable in
 * practice; authorization for the actual write still runs before anything
 * is inserted. */
async function findMarker(ctx: MutationCtx, key: string) {
  return await ctx.db
    .query("spoolMarkers")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
}

async function writeMarker(ctx: MutationCtx, key: string, runId?: Id<"runs">) {
  await ctx.db.insert("spoolMarkers", { key, runId, createdAt: Date.now() });
}

export const createRun = mutation({
  args: { key: v.string(), ...runCreateArgs },
  handler: async (ctx, { key, ...args }) => {
    // Same gate as runs.create, before anything else — including the marker
    // lookup, so an unauthorized caller learns nothing about existing keys.
    const writer = await authorizeExperimentWrite(ctx, args.experimentId);
    const seen = await findMarker(ctx, key);
    if (seen) {
      // Replayed record: hand back the run the first application created so
      // the client's ID mapping stays intact. A marker without a runId can
      // only mean the table was tampered with — fail loudly.
      if (!seen.runId) throw new Error(`spool marker ${key} carries no runId`);
      return seen.runId;
    }
    const runId = await insertRun(ctx, args, writer?.userId);
    await writeMarker(ctx, key, runId);
    return runId;
  },
});

/** Shared body of the append guards, called AFTER the handler's gate: skip
 * when the key was applied, else insert the items in order and record the
 * marker — one transaction. */
async function appendOnce<T extends RunChildTable>(
  ctx: MutationCtx,
  table: T,
  key: string,
  runId: Id<"runs">,
  items: RunChildItem<T>[],
): Promise<null> {
  const seen = await findMarker(ctx, key);
  if (seen) return null;
  await appendRunChildren(ctx, table, runId, items);
  await writeMarker(ctx, key);
  return null;
}

export const appendEvents = mutation({
  args: {
    key: v.string(),
    runId: v.id("runs"),
    items: v.array(v.object(eventFields)),
  },
  handler: async (ctx, { key, runId, items }) => {
    await gateRunWrite(ctx, runId);
    return await appendOnce(ctx, "events", key, runId, items);
  },
});

export const appendMetrics = mutation({
  args: {
    key: v.string(),
    runId: v.id("runs"),
    items: v.array(v.object(metricFields)),
  },
  handler: async (ctx, { key, runId, items }) => {
    await gateRunWrite(ctx, runId);
    return await appendOnce(ctx, "metrics", key, runId, items);
  },
});

export const appendLogs = mutation({
  args: {
    key: v.string(),
    runId: v.id("runs"),
    items: v.array(v.object(logFields)),
  },
  handler: async (ctx, { key, runId, items }) => {
    await gateRunWrite(ctx, runId);
    return await appendOnce(ctx, "logs", key, runId, items);
  },
});

export const appendSysSamples = mutation({
  args: {
    key: v.string(),
    runId: v.id("runs"),
    items: v.array(v.object(sysSampleFields)),
  },
  handler: async (ctx, { key, runId, items }) => {
    await gateRunWrite(ctx, runId);
    return await appendOnce(ctx, "sysSamples", key, runId, items);
  },
});
