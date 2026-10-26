import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { logFields } from "./schema";
import { appendRunChildren } from "./lib/runChildren";
import { gateRunRead, gateRunWrite } from "./authz";

// Same columns as the logs table minus runId (schema.ts is the source of
// truth); appendMany supplies runId itself.
const logItem = v.object(logFields);

export const appendMany = mutation({
  args: { runId: v.id("runs"), items: v.array(logItem) },
  handler: async (ctx, { runId, items }) => {
    await gateRunWrite(ctx, runId);
    await appendRunChildren(ctx, "logs", runId, items);
  },
});

// Convex rejects a query whose return array exceeds 8192 entries, and a noisy
// long run can emit far more log lines than that. Log lines can't be downsampled
// (every line is meaningful), so we return the most recent MAX_LINES — the tail
// is what matters for diagnostics — in ascending (oldest-first) order to match
// how the viewer renders them.
const MAX_LINES = 5000;

export const listForRun = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    await gateRunRead(ctx, runId);
    const newestFirst = await ctx.db
      .query("logs")
      .withIndex("by_run_ts", (q) => q.eq("runId", runId))
      .order("desc")
      .take(MAX_LINES);
    return newestFirst.reverse();
  },
});
