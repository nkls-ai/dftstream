import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { frequencyFields } from "./schema";
import { appendRunChildren, replaceRunChildren } from "./lib/runChildren";
import { gateRunRead, gateRunWrite } from "./authz";

// Same columns as the frequencies table minus runId (schema.ts is the source
// of truth); setAll supplies runId itself.
const freqItem = v.object(frequencyFields);

export const setAll = mutation({
  args: {
    runId: v.id("runs"),
    items: v.array(freqItem),
    // 1-based hessian ordinal. Absent = legacy wholesale replace (old
    // wrappers); present = replace only that hessian's rows so earlier
    // hessians accumulate as history.
    hessIdx: v.optional(v.number()),
  },
  handler: async (ctx, { runId, items, hessIdx }) => {
    await gateRunWrite(ctx, runId);
    if (hessIdx == null) {
      await replaceRunChildren(ctx, "frequencies", runId, items);
      return;
    }
    const existing = await ctx.db
      .query("frequencies")
      .withIndex("by_run_idx", (q) => q.eq("runId", runId))
      .collect();
    for (const row of existing) {
      // Same-hessian rows are being rewritten; undefined-hessIdx rows are
      // stale output of an older wrapper version and would double-count.
      if (row.hessIdx === hessIdx || row.hessIdx === undefined) {
        await ctx.db.delete(row._id);
      }
    }
    await appendRunChildren(
      ctx,
      "frequencies",
      runId,
      items.map((item) => ({ ...item, hessIdx })),
    );
  },
});

export const getForRun = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    await gateRunRead(ctx, runId);
    return await ctx.db
      .query("frequencies")
      .withIndex("by_run_idx", (q) => q.eq("runId", runId))
      .collect();
  },
});
