import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { pathwayPoint } from "./schema";
import { requireNonEmptyName } from "./lib/util";
import {
  authEnabled,
  authorizeExperimentWrite,
  gateExperimentRead,
  gateExperimentRowModify,
  gatePathwayRead,
  orgOfExperiment,
  orgOfRun,
  requireCanModify,
} from "./authz";

// Every point references a run; under auth those runs must belong to the same
// org as the pathway's experiment. Otherwise a member could stitch another
// org's runs into their pathway and the detail view would resolve+render that
// foreign run's data (cross-org read leak).
async function assertPointsInOrg(
  ctx: Parameters<typeof orgOfRun>[0],
  org: Id<"organizations">,
  points: { runId: Id<"runs"> }[],
): Promise<void> {
  for (const pt of points) {
    if ((await orgOfRun(ctx, pt.runId)) !== org) {
      throw new Error("pathway point references a run outside this organization");
    }
  }
}

export const list = query({
  args: { experimentId: v.id("experiments") },
  handler: async (ctx, { experimentId }) => {
    await gateExperimentRead(ctx, experimentId);
    const rows = await ctx.db
      .query("pathways")
      .withIndex("by_experiment", (q) => q.eq("experimentId", experimentId))
      .collect();
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  },
});

export const get = query({
  args: { pathwayId: v.id("pathways") },
  handler: async (ctx, { pathwayId }) => {
    const pw = await ctx.db.get(pathwayId);
    if (!pw) return null;
    await gatePathwayRead(ctx, pathwayId);
    return pw;
  },
});

export const create = mutation({
  args: {
    experimentId: v.id("experiments"),
    name: v.string(),
    // Shares the pathways table's point validator (schema.ts).
    points: v.array(pathwayPoint),
  },
  handler: async (ctx, { experimentId, name, points }) => {
    const trimmed = requireNonEmptyName(name);
    const writer = await authorizeExperimentWrite(ctx, experimentId);
    if (writer) await assertPointsInOrg(ctx, writer.orgId, points);
    return await ctx.db.insert("pathways", {
      experimentId,
      name: trimmed,
      createdAt: Date.now(),
      createdBy: writer?.userId,
      points,
    });
  },
});

export const rename = mutation({
  args: { pathwayId: v.id("pathways"), name: v.string() },
  handler: async (ctx, { pathwayId, name }) => {
    const trimmed = requireNonEmptyName(name);
    if (authEnabled()) {
      const pw = await ctx.db.get(pathwayId);
      if (!pw) throw new Error("pathway not found");
      await requireCanModify(
        ctx,
        await orgOfExperiment(ctx, pw.experimentId),
        pw.createdBy,
      );
    }
    await ctx.db.patch(pathwayId, { name: trimmed });
  },
});

export const updatePoints = mutation({
  args: { pathwayId: v.id("pathways"), points: v.array(pathwayPoint) },
  handler: async (ctx, { pathwayId, points }) => {
    if (authEnabled()) {
      const pw = await ctx.db.get(pathwayId);
      if (!pw) throw new Error("pathway not found");
      const org = await orgOfExperiment(ctx, pw.experimentId);
      await requireCanModify(ctx, org, pw.createdBy);
      await assertPointsInOrg(ctx, org, points);
    }
    await ctx.db.patch(pathwayId, { points });
  },
});

export const remove = mutation({
  args: { pathwayId: v.id("pathways") },
  handler: async (ctx, { pathwayId }) => {
    const pw = await ctx.db.get(pathwayId);
    if (!pw) return;
    await gateExperimentRowModify(ctx, pw.experimentId, pw.createdBy);
    await ctx.db.delete(pathwayId);
  },
});
