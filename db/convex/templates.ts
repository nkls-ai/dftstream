import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireNonEmptyName } from "./lib/util";
import { ORG_ROLE } from "./schema";
import {
  authEnabled,
  currentUserId,
  requireCanModify,
  resolveOrgScope,
} from "./authz";

// The org's shared input-builder templates: a named, described builder
// state a colleague can load instead of retyping the group's standard
// level of theory. The payload is opaque JSON to the backend — the UI
// owns its shape and stamps `stateVersion` so a newer payload is refused
// by an older client rather than half-read (see lib/inputBuilder/templates.ts).
//
// Local single-user mode (auth off) runs the same functions with the org
// gates skipped, exactly like every other module here.

// Templates are recipes, not data sets: a payload past this is a sign
// something (a structure, a whole trajectory) is being smuggled into the
// library, which is not what it is for.
const MAX_STATE_BYTES = 64 * 1024;
const MAX_DESCRIPTION_CHARS = 2000;

function checkPayload(state: string, description: string): void {
  if (state.length > MAX_STATE_BYTES) {
    throw new Error(
      `template state is ${state.length} bytes, over the ${MAX_STATE_BYTES}-byte limit — ` +
        `a template carries settings, not structures`,
    );
  }
  if (description.length > MAX_DESCRIPTION_CHARS) {
    throw new Error(`template description is over ${MAX_DESCRIPTION_CHARS} characters`);
  }
}

export const list = query({
  args: { organizationId: v.optional(v.id("organizations")) },
  handler: async (ctx, { organizationId }) => {
    const scope = await resolveOrgScope(ctx, organizationId);
    return scope === null
      ? await ctx.db
          .query("inputTemplates")
          .withIndex("by_updatedAt")
          .order("desc")
          .collect()
      : await ctx.db
          .query("inputTemplates")
          .withIndex("by_org_updatedAt", (q) => q.eq("organizationId", scope))
          .order("desc")
          .collect();
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    description: v.string(),
    state: v.string(),
    stateVersion: v.number(),
    organizationId: v.optional(v.id("organizations")),
  },
  handler: async (ctx, { name, description, state, stateVersion, organizationId }) => {
    const trimmed = requireNonEmptyName(name, "template name");
    checkPayload(state, description);
    const scope = await resolveOrgScope(ctx, organizationId, ORG_ROLE.MEMBER);
    const now = Date.now();
    return await ctx.db.insert("inputTemplates", {
      // Org-less (and creator-less) only in local single-user mode.
      organizationId: scope ?? undefined,
      name: trimmed,
      description,
      state,
      stateVersion,
      createdBy: scope === null ? undefined : await currentUserId(ctx),
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const update = mutation({
  args: {
    templateId: v.id("inputTemplates"),
    name: v.string(),
    description: v.string(),
    state: v.string(),
    stateVersion: v.number(),
  },
  handler: async (ctx, { templateId, name, description, state, stateVersion }) => {
    const trimmed = requireNonEmptyName(name, "template name");
    checkPayload(state, description);
    const row = await ctx.db.get(templateId);
    if (!row) throw new Error("template not found");
    if (authEnabled()) {
      if (!row.organizationId) throw new Error("template not found");
      await requireCanModify(ctx, row.organizationId, row.createdBy);
    }
    await ctx.db.patch(templateId, {
      name: trimmed,
      description,
      state,
      stateVersion,
      updatedAt: Date.now(),
    });
  },
});

export const remove = mutation({
  args: { templateId: v.id("inputTemplates") },
  handler: async (ctx, { templateId }) => {
    const row = await ctx.db.get(templateId);
    if (!row) return;
    if (authEnabled()) {
      if (!row.organizationId) throw new Error("template not found");
      await requireCanModify(ctx, row.organizationId, row.createdBy);
    }
    await ctx.db.delete(templateId);
  },
});
