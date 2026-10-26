import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { nmrShieldFields } from "./schema";
import { replaceRunChildren } from "./lib/runChildren";
import { gateRunRead, gateRunWrite } from "./authz";

export const setAll = mutation({
  args: {
    runId: v.id("runs"),
    // Same columns as the nmrShields table minus runId (schema.ts is the
    // source of truth); setAll supplies runId itself.
    items: v.array(v.object(nmrShieldFields)),
  },
  handler: async (ctx, { runId, items }) => {
    await gateRunWrite(ctx, runId);
    await replaceRunChildren(ctx, "nmrShields", runId, items);
  },
});

export const listForRun = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    await gateRunRead(ctx, runId);
    return await ctx.db
      .query("nmrShields")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();
  },
});
