import { v } from "convex/values";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { ORG_ROLE, orgRole } from "./schema";
import { requireNonEmptyName } from "./lib/util";
import { accountEmailVerified } from "./lib/identityProviders";
import {
  removeOrgCredentials,
  revokeMemberCredentials,
} from "./lib/credentialRevocation";
import {
  cliTokenOrg,
  currentUserId,
  maybeAppUser,
  normalizeEmail,
  requireBrowserIdentity,
  requireMembership,
  requireOrgRole,
  type OrgRole,
} from "./authz";

// --- slug helpers -----------------------------------------------------------

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : "org";
}

async function uniqueSlug(ctx: MutationCtx, name: string): Promise<string> {
  const base = slugify(name);
  for (let attempt = 0; attempt < 1000; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const taken = await ctx.db
      .query("organizations")
      .withIndex("by_slug", (q) => q.eq("slug", candidate))
      .unique();
    if (!taken) return candidate;
  }
  // 1000 same-named orgs is implausible, but never silently collide.
  throw new Error("could not allocate a unique organization slug");
}

// --- queries ----------------------------------------------------------------

// Orgs the caller belongs to, with their role. Empty for an unprovisioned or
// unauthenticated user (never throws — the UI uses this to drive the switcher).
export const myOrgs = query({
  args: {},
  handler: async (ctx) => {
    const user = await maybeAppUser(ctx);
    if (!user) return [];
    // myOrgs answers from memberships directly rather than through
    // requireMembership, so the CLI scope check has to be repeated here — else
    // a token approved for one org could still enumerate the names and slugs of
    // every other org its human belongs to.
    const scoped = await cliTokenOrg(ctx);
    const memberships = (
      await ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("appUserId", user._id))
        .collect()
    ).filter((m) => !scoped || m.organizationId === scoped);
    const out: {
      organizationId: Id<"organizations">;
      name: string;
      slug: string;
      role: OrgRole;
    }[] = [];
    for (const m of memberships) {
      const org = await ctx.db.get(m.organizationId);
      if (!org) continue;
      out.push({
        organizationId: org._id,
        name: org.name,
        slug: org.slug,
        role: m.role,
      });
    }
    return out;
  },
});

// The caller's role in one org, or null if not a member.
export const myRole = query({
  args: { organizationId: v.id("organizations") },
  handler: async (ctx, { organizationId }) => {
    // Unauthenticated or not-yet-provisioned callers simply have no role;
    // surface that as null instead of erroring the whole page (same contract
    // as myOrgs/me).
    const user = await maybeAppUser(ctx);
    if (!user) return null;
    // Same reasoning as myOrgs: out-of-scope for this CLI token means "no
    // role", not the human's real role.
    const scoped = await cliTokenOrg(ctx);
    if (scoped && scoped !== organizationId) return null;
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_user_org", (q) =>
        q.eq("appUserId", user._id).eq("organizationId", organizationId),
      )
      .unique();
    return membership?.role ?? null;
  },
});

// Members of an org with their email/name + role. Any member may view the roster.
export const members = query({
  args: { organizationId: v.id("organizations") },
  handler: async (ctx, { organizationId }) => {
    await requireMembership(ctx, organizationId);
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_org", (q) => q.eq("organizationId", organizationId))
      .collect();
    const out: {
      membershipId: Id<"memberships">;
      appUserId: Id<"appUsers">;
      email: string | null;
      name: string | null;
      role: OrgRole;
    }[] = [];
    for (const m of memberships) {
      const u = await ctx.db.get(m.appUserId);
      out.push({
        membershipId: m._id,
        appUserId: m.appUserId,
        email: u?.email ?? null,
        name: u?.name ?? null,
        role: m.role,
      });
    }
    return out;
  },
});

// --- mutations --------------------------------------------------------------

// Any authenticated user can create an org (GitHub-style) and becomes its owner.
export const create = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    await requireBrowserIdentity(ctx);
    const trimmed = requireNonEmptyName(name);
    const appUserId = await currentUserId(ctx);
    const slug = await uniqueSlug(ctx, trimmed);
    const organizationId = await ctx.db.insert("organizations", {
      name: trimmed,
      slug,
      createdAt: Date.now(),
      createdBy: appUserId,
    });
    await ctx.db.insert("memberships", {
      appUserId,
      organizationId,
      role: ORG_ROLE.OWNER,
      createdAt: Date.now(),
    });
    return { organizationId, slug };
  },
});

// Count owners so we never strand an org without one.
async function ownerCount(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
): Promise<number> {
  const all = await ctx.db
    .query("memberships")
    .withIndex("by_org", (q) => q.eq("organizationId", organizationId))
    .collect();
  return all.filter((m) => m.role === ORG_ROLE.OWNER).length;
}

// Whether this account's stored email is SELF-ASSERTED rather than verified,
// as decided by the identity provider that minted the account
// (lib/identityProviders.ts). The deployment's own convex-auth Password flow
// performs no email verification, so anyone can sign up as any address —
// including an address an admin is about to invite. Accounts from any other
// trusted issuer (Clerk, whatever an operator configures) are assumed to have
// had their email verified by that provider (docs/auth.md). Unset
// CONVEX_SITE_URL means we cannot classify, so it fails closed.
function hasUnverifiedEmail(user: Doc<"appUsers">): boolean {
  return !accountEmailVerified(user.tokenIdentifier);
}

// The pending invite (if any) an org holds for a normalized email.
async function pendingInviteFor(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  email: string,
) {
  return await ctx.db
    .query("orgInvites")
    .withIndex("by_org_email", (q) =>
      q.eq("organizationId", organizationId).eq("email", email),
    )
    .unique();
}

// Insert the membership and consume any pending invite for the address.
// Throws if the user already holds a membership in the org.
async function grantMembership(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  appUserId: Id<"appUsers">,
  role: OrgRole,
  email: string,
) {
  const existing = await ctx.db
    .query("memberships")
    .withIndex("by_user_org", (q) =>
      q.eq("appUserId", appUserId).eq("organizationId", organizationId),
    )
    .unique();
  if (existing) throw new Error("user is already a member");
  const membershipId = await ctx.db.insert("memberships", {
    appUserId,
    organizationId,
    role,
    createdAt: Date.now(),
  });
  const invite = await pendingInviteFor(ctx, organizationId, email);
  if (invite) await ctx.db.delete(invite._id);
  return { status: "added" as const, membershipId };
}

// Add a user (by email) to an org. Only owners may grant the owner role;
// admins may grant admin/member/viewer. Three outcomes:
//
//   { status: "invited" }             no account for that email yet — a
//                                     pending orgInvites row was recorded and
//                                     NOTHING was granted. Auto-redeeming it
//                                     at sign-up would hand the membership to
//                                     whoever registers the address first
//                                     (Password-provider emails are never
//                                     verified), so the admin must call
//                                     addMember again once the person has
//                                     signed in.
//   { status: "needs-confirmation" }  an account exists but its email is
//                                     self-asserted (see hasUnverifiedEmail).
//                                     Nothing was granted; the candidate's
//                                     creation time / last activity are
//                                     returned so the admin can verify
//                                     OUT-OF-BAND that the account belongs to
//                                     the person they mean, then re-call with
//                                     confirmUserId to grant.
//   { status: "added" }               membership created — either the email
//                                     came from a verifying issuer, or the
//                                     admin explicitly confirmed the account.
export const addMember = mutation({
  args: {
    organizationId: v.id("organizations"),
    email: v.string(),
    role: orgRole,
    // Explicit second-step confirmation: grants to exactly this account, and
    // only while it still carries the given email. Binding the grant to an id
    // the admin reviewed (rather than re-matching the email blind) closes the
    // race where a different account claims the address between review and
    // confirmation.
    confirmUserId: v.optional(v.id("appUsers")),
  },
  handler: async (ctx, { organizationId, email, role, confirmUserId }) => {
    await requireBrowserIdentity(ctx);
    const caller = await requireOrgRole(ctx, organizationId, ORG_ROLE.ADMIN);
    if (role === ORG_ROLE.OWNER && caller.role !== ORG_ROLE.OWNER) {
      throw new Error("only an owner can grant the owner role");
    }
    const normalized = normalizeEmail(email);
    if (normalized.length === 0) throw new Error("email must not be empty");

    if (confirmUserId) {
      const target = await ctx.db.get(confirmUserId);
      if (
        !target ||
        !target.email ||
        normalizeEmail(target.email) !== normalized
      ) {
        throw new Error(
          "that account no longer matches the invited email — review the candidate again before confirming",
        );
      }
      return await grantMembership(
        ctx,
        organizationId,
        target._id,
        role,
        normalized,
      );
    }

    // by_email is not a unique index: one human signing in via two issuers
    // (e.g. convex-auth and Clerk) yields two appUsers rows with the same
    // backfilled email, so .unique() would throw an opaque error here.
    const matches = await ctx.db
      .query("appUsers")
      .withIndex("by_email", (q) => q.eq("email", normalized))
      .take(2);
    if (matches.length > 1) {
      throw new Error(
        "that email is linked to more than one account — the user must sign in with a single provider before being invited",
      );
    }

    if (matches.length === 0) {
      // Record the intent instead of failing. Grants NOTHING — see the
      // contract comment above for why this is never auto-redeemed.
      const existingInvite = await pendingInviteFor(
        ctx,
        organizationId,
        normalized,
      );
      if (existingInvite) {
        if (existingInvite.role !== role) {
          await ctx.db.patch(existingInvite._id, { role });
        }
        return { status: "invited" as const, inviteId: existingInvite._id };
      }
      const inviteId = await ctx.db.insert("orgInvites", {
        organizationId,
        email: normalized,
        role,
        invitedBy: caller.appUserId,
        createdAt: Date.now(),
      });
      return { status: "invited" as const, inviteId };
    }

    const target = matches[0]!;
    // Checked before the confirmation branch: asking an admin to confirm an
    // account that is already in the org only ends in "already a member"
    // after they have done the out-of-band check.
    const alreadyMember = await ctx.db
      .query("memberships")
      .withIndex("by_user_org", (q) =>
        q.eq("appUserId", target._id).eq("organizationId", organizationId),
      )
      .unique();
    if (alreadyMember) throw new Error("user is already a member");
    if (hasUnverifiedEmail(target)) {
      // Never grant on a self-asserted email match alone: an attacker who
      // registered the address before its real owner would silently receive
      // the membership. Surface what we know about the account and make the
      // admin confirm it explicitly.
      const invite = await pendingInviteFor(ctx, organizationId, normalized);
      return {
        status: "needs-confirmation" as const,
        candidate: {
          userId: target._id,
          email: normalized,
          name: target.name ?? null,
          // An account created AFTER the invite was recorded is the classic
          // pre-registration-hijack shape — the admin should verify with the
          // person before confirming.
          accountCreatedAt: target.createdAt,
          lastSeenAt: target.lastSeenAt ?? null,
          invitePendingSince: invite?.createdAt ?? null,
        },
      };
    }
    return await grantMembership(
      ctx,
      organizationId,
      target._id,
      role,
      normalized,
    );
  },
});

// Pending (not-yet-confirmed) invites for an org. Admin-tier: invites reveal
// who the org is trying to recruit, which is more than the member roster.
export const listInvites = query({
  args: { organizationId: v.id("organizations") },
  handler: async (ctx, { organizationId }) => {
    await requireOrgRole(ctx, organizationId, ORG_ROLE.ADMIN);
    const invites = await ctx.db
      .query("orgInvites")
      .withIndex("by_org", (q) => q.eq("organizationId", organizationId))
      .collect();
    return invites.map((i) => ({
      inviteId: i._id,
      email: i.email,
      role: i.role,
      createdAt: i.createdAt,
    }));
  },
});

// Withdraw a pending invite. Idempotent: a vanished invite is already the
// desired state.
export const revokeInvite = mutation({
  args: { inviteId: v.id("orgInvites") },
  handler: async (ctx, { inviteId }) => {
    await requireBrowserIdentity(ctx);
    const invite = await ctx.db.get(inviteId);
    if (!invite) return;
    await requireOrgRole(ctx, invite.organizationId, ORG_ROLE.ADMIN);
    await ctx.db.delete(inviteId);
  },
});

export const updateRole = mutation({
  args: { membershipId: v.id("memberships"), role: orgRole },
  handler: async (ctx, { membershipId, role }) => {
    await requireBrowserIdentity(ctx);
    const membership = await ctx.db.get(membershipId);
    if (!membership) throw new Error("membership not found");
    const caller = await requireOrgRole(
      ctx,
      membership.organizationId,
      ORG_ROLE.ADMIN,
    );
    if (
      (role === ORG_ROLE.OWNER || membership.role === ORG_ROLE.OWNER) &&
      caller.role !== ORG_ROLE.OWNER
    ) {
      throw new Error("only an owner can change owner roles");
    }
    if (
      membership.role === ORG_ROLE.OWNER &&
      role !== ORG_ROLE.OWNER &&
      (await ownerCount(ctx, membership.organizationId)) <= 1
    ) {
      throw new Error("an organization must keep at least one owner");
    }
    await ctx.db.patch(membershipId, { role });
  },
});

export const removeMember = mutation({
  args: { membershipId: v.id("memberships") },
  handler: async (ctx, { membershipId }) => {
    await requireBrowserIdentity(ctx);
    const membership = await ctx.db.get(membershipId);
    if (!membership) return;
    const caller = await requireOrgRole(ctx, membership.organizationId, ORG_ROLE.ADMIN);
    // Removing an owner is an owner-tier act. updateRole already refuses to let
    // an admin touch an owner row; without the same rule here an admin could
    // simply delete the co-owners instead of demoting them and end up the
    // effective top of the org.
    if (membership.role === ORG_ROLE.OWNER && caller.role !== ORG_ROLE.OWNER) {
      throw new Error("only an owner can remove an owner");
    }
    if (
      membership.role === ORG_ROLE.OWNER &&
      (await ownerCount(ctx, membership.organizationId)) <= 1
    ) {
      throw new Error("an organization must keep at least one owner");
    }
    await ctx.db.delete(membershipId);
    await revokeMemberCredentials(
      ctx,
      membership.organizationId,
      membership.appUserId,
    );
  },
});

export const rename = mutation({
  args: { organizationId: v.id("organizations"), name: v.string() },
  handler: async (ctx, { organizationId, name }) => {
    await requireBrowserIdentity(ctx);
    const trimmed = requireNonEmptyName(name);
    await requireOrgRole(ctx, organizationId, ORG_ROLE.ADMIN);
    await ctx.db.patch(organizationId, { name: trimmed });
  },
});

// Owner-only. Refuses while the org still owns experiments — delete those first
// so we never orphan run/child data behind a removed org.
export const remove = mutation({
  args: { organizationId: v.id("organizations") },
  handler: async (ctx, { organizationId }) => {
    await requireBrowserIdentity(ctx);
    await requireOrgRole(ctx, organizationId, ORG_ROLE.OWNER);
    const anyExperiment = await ctx.db
      .query("experiments")
      .withIndex("by_org_createdAt", (q) =>
        q.eq("organizationId", organizationId),
      )
      .first();
    if (anyExperiment) {
      throw new Error(
        "organization still has experiments — delete them before removing it",
      );
    }
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_org", (q) => q.eq("organizationId", organizationId))
      .collect();
    await removeOrgCredentials(
      ctx,
      organizationId,
      memberships.map((m) => m.appUserId),
    );
    for (const m of memberships) await ctx.db.delete(m._id);
    // Pending invites die with the org — a confirmed invite into a deleted
    // org is meaningless, and orphaned rows would leak the recruiting list.
    const invites = await ctx.db
      .query("orgInvites")
      .withIndex("by_org", (q) => q.eq("organizationId", organizationId))
      .collect();
    for (const i of invites) await ctx.db.delete(i._id);
    await ctx.db.delete(organizationId);
  },
});

// --- import unassigned (pre-auth) data --------------------------------------

const IMPORT_BATCH = 100;

// One-time move of every org-less (pre-auth) experiment into one org. This is
// a deployment-owner operation, deliberately NOT exposed in the UI or public
// API — run it from the machine that owns the Convex deployment:
//
//   cd db && bunx convex run organizations:importUnassignedNow '{"organizationId":"<id>"}'
//
// Chained scheduler steps keep each transaction bounded (see experiments.ts).
export const importUnassignedNow = internalMutation({
  args: { organizationId: v.id("organizations") },
  handler: async (ctx, { organizationId }) => {
    const org = await ctx.db.get(organizationId);
    if (!org) throw new Error("organization not found");
    await importUnassignedBatch(ctx, organizationId, org.createdBy);
  },
});

export const _importUnassignedStep = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    claimerUserId: v.id("appUsers"),
  },
  handler: async (ctx, { organizationId, claimerUserId }) => {
    await importUnassignedBatch(ctx, organizationId, claimerUserId);
  },
});

async function importUnassignedBatch(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  claimerUserId: Id<"appUsers">,
) {
  const orphans = await ctx.db
    .query("experiments")
    .withIndex("by_org_createdAt", (q) => q.eq("organizationId", undefined))
    .take(IMPORT_BATCH);
  for (const exp of orphans) {
    await ctx.db.patch(exp._id, {
      organizationId,
      createdBy: exp.createdBy ?? claimerUserId,
    });
  }
  if (orphans.length === IMPORT_BATCH) {
    await ctx.scheduler.runAfter(50, internal.organizations._importUnassignedStep, {
      organizationId,
      claimerUserId,
    });
  }
}

// --- one-shot email normalization -------------------------------------------

const NORMALIZE_BATCH = 100;

// One-time canonicalization of appUsers.email rows written before emails were
// normalized on write (authz.normalizeEmail). A mixed-case stored email is
// invisible to addMember's exact-match by_email index. Deployment-owner
// operation, same pattern as importUnassignedNow:
//
//   cd db && bunx convex run organizations:normalizeEmailsNow '{}'
//
// (currentUserId also self-heals a row on the user's next authenticated
// mutation, so this is a completeness pass, not a correctness requirement.
// It lives here rather than migrations.ts because that module is owned by a
// concurrent change.)
export const normalizeEmailsNow = internalMutation({
  args: {},
  handler: async (ctx) => {
    await normalizeEmailBatch(ctx, 0);
  },
});

export const _normalizeEmailsStep = internalMutation({
  args: { afterCreationTime: v.number() },
  handler: async (ctx, { afterCreationTime }) => {
    await normalizeEmailBatch(ctx, afterCreationTime);
  },
});

async function normalizeEmailBatch(
  ctx: MutationCtx,
  afterCreationTime: number,
) {
  const page = await ctx.db
    .query("appUsers")
    .withIndex("by_creation_time", (q) =>
      q.gt("_creationTime", afterCreationTime),
    )
    .take(NORMALIZE_BATCH);
  for (const u of page) {
    if (!u.email) continue;
    const canonical = normalizeEmail(u.email);
    if (canonical !== u.email) await ctx.db.patch(u._id, { email: canonical });
  }
  const last = page[page.length - 1];
  if (page.length === NORMALIZE_BATCH && last) {
    await ctx.scheduler.runAfter(50, internal.organizations._normalizeEmailsStep, {
      afterCreationTime: last._creationTime,
    });
  }
}
