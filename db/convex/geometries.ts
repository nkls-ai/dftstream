import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { gateRunRead, gateRunWrite } from "./authz";

export const append = mutation({
  args: {
    runId: v.id("runs"),
    cycle: v.number(),
    xyz: v.string(),
  },
  handler: async (ctx, { runId, cycle, xyz }) => {
    await gateRunWrite(ctx, runId);
    const existing = await ctx.db
      .query("geometries")
      .withIndex("by_run_cycle", (q) =>
        q.eq("runId", runId).eq("cycle", cycle),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { xyz, ts: Date.now() });
      return existing._id;
    }
    return await ctx.db.insert("geometries", {
      runId,
      cycle,
      xyz,
      ts: Date.now(),
    });
  },
});

// Convex caps a query at 8 MiB of returned data (and 16 MiB read), and an
// optimization trajectory can run to thousands of cycles of an xyz block that
// grows with atom count — the old unbounded collect() threw on exactly the
// long, large runs a chemist most wants to look at. The trajectory viewer
// needs the start and the end, so the bound keeps:
//   - the FIRST cycle (the input geometry), and
//   - the newest cycles, back from the latest, until MAX_GEOMETRIES rows or
//     MAX_GEOMETRY_BYTES of xyz text, whichever comes first,
// returned in ascending cycle order — the same shape (and, for any run under
// the bound, the same rows) as before. Cycles in between are dropped when the
// bound bites; the viewer then animates a contiguous tail plus the start.
const MAX_GEOMETRIES = 1000;
const MAX_GEOMETRY_BYTES = 4 * 1024 * 1024;

export const listForRun = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    await gateRunRead(ctx, runId);
    const byCycle = () =>
      ctx.db
        .query("geometries")
        .withIndex("by_run_cycle", (q) => q.eq("runId", runId));
    const first = await byCycle().first();
    if (!first) return [];
    const newestFirst: Doc<"geometries">[] = [];
    let bytes = first.xyz.length;
    // Streamed newest-first so the read stops at the bound instead of
    // loading the whole trajectory to discard most of it.
    for await (const row of byCycle().order("desc")) {
      if (row._id === first._id) break;
      if (newestFirst.length + 1 >= MAX_GEOMETRIES) break;
      if (bytes + row.xyz.length > MAX_GEOMETRY_BYTES) break;
      bytes += row.xyz.length;
      newestFirst.push(row);
    }
    return [first, ...newestFirst.reverse()];
  },
});
