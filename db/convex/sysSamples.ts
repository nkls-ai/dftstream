import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { sysSampleFields } from "./schema";
import { appendRunChildren } from "./lib/runChildren";
import { gateRunRead, gateRunWrite } from "./authz";

// Same columns as the sysSamples table minus runId (schema.ts is the source
// of truth); appendMany supplies runId itself.
const sysItem = v.object(sysSampleFields);

export const appendMany = mutation({
  args: { runId: v.id("runs"), items: v.array(sysItem) },
  handler: async (ctx, { runId, items }) => {
    await gateRunWrite(ctx, runId);
    await appendRunChildren(ctx, "sysSamples", runId, items);
  },
});

// Convex rejects a query whose return value is an array longer than 8192 (a
// hard backend limit), and a single .collect() is also bounded by the per-query
// document-scan limit. A long-running job samples hardware every few seconds,
// so its sysSamples easily blow past both — ~8600 rows for a ~12h run crashed
// the whole UI. We page the series instead: the client streams every page (see
// useRunSysSamples) and reassembles the full, lossless set, so no sample is
// dropped no matter how long the run is.
export const forRun = query({
  args: { runId: v.id("runs"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { runId, paginationOpts }) => {
    await gateRunRead(ctx, runId);
    return await ctx.db
      .query("sysSamples")
      .withIndex("by_run_ts", (q) => q.eq("runId", runId))
      .paginate(paginationOpts);
  },
});
