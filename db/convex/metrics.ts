import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { metricFields } from "./schema";
import { appendRunChildren } from "./lib/runChildren";
import { gateRunRead, gateRunWrite } from "./authz";

// Same columns as the metrics table minus runId (schema.ts is the source of
// truth); appendMany supplies runId itself.
const metricItem = v.object(metricFields);

export const appendMany = mutation({
  args: { runId: v.id("runs"), items: v.array(metricItem) },
  handler: async (ctx, { runId, items }) => {
    await gateRunWrite(ctx, runId);
    await appendRunChildren(ctx, "metrics", runId, items);
  },
});

// Convex rejects a query whose return array exceeds 8192 entries, and a single
// .collect() is also bounded by the per-query document-scan limit. A metric like
// scf_iter_energy records one row per SCF iteration, so a long geometry
// optimization (many cycles × many iterations) can blow past both. We page the
// series instead: the client streams every page (see useRunMetrics) and
// reassembles the full, lossless set — no iteration is dropped.
// Paged: returns one page of the metric series; the client streams every page.
export const byRunKey = query({
  args: {
    runId: v.id("runs"),
    key: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { runId, key, paginationOpts }) => {
    await gateRunRead(ctx, runId);
    return await ctx.db
      .query("metrics")
      .withIndex("by_run_key_ts", (q) =>
        q.eq("runId", runId).eq("key", key),
      )
      .paginate(paginationOpts);
  },
});
