import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { eventFields } from "./schema";
import { appendRunChildren } from "./lib/runChildren";
import { gateRunRead, gateRunWrite } from "./authz";

// Same columns as the events table minus runId (schema.ts is the source of
// truth); appendMany supplies runId itself.
const eventItem = v.object(eventFields);

export const appendMany = mutation({
  args: { runId: v.id("runs"), items: v.array(eventItem) },
  handler: async (ctx, { runId, items }) => {
    await gateRunWrite(ctx, runId);
    await appendRunChildren(ctx, "events", runId, items);
  },
});

// Convex rejects a query whose return array exceeds 8192 entries; a long run
// can record more events than that. We return the most recent MAX_EVENTS (the
// tail is what the log viewer surfaces) in ascending (oldest-first) seq order.
const MAX_EVENTS = 5000;

export const listForRun = query({
  args: { runId: v.id("runs"), sinceSeq: v.optional(v.number()) },
  handler: async (ctx, { runId, sinceSeq }) => {
    await gateRunRead(ctx, runId);
    if (sinceSeq !== undefined) {
      // Incremental fetch: oldest-first after the cursor, so consecutive polls
      // stay contiguous. Taking the newest MAX_EVENTS here would silently skip
      // a block whenever more than MAX_EVENTS arrive between two polls — the
      // client advances its cursor past the gap and never recovers the events.
      return await ctx.db
        .query("events")
        .withIndex("by_run_seq", (q) =>
          q.eq("runId", runId).gt("seq", sinceSeq),
        )
        .take(MAX_EVENTS);
    }
    const newestFirst = await ctx.db
      .query("events")
      .withIndex("by_run_seq", (q) => q.eq("runId", runId))
      .order("desc")
      .take(MAX_EVENTS);
    return newestFirst.reverse();
  },
});
