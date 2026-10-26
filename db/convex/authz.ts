import type { Infer } from "convex/values";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { ORG_ROLE, orgRole } from "./schema";
import {
  PRINCIPAL_KIND,
  cliSubject,
  normalizeEmail,
  principalOf,
  profileOf,
  type Principal,
} from "./lib/identityProviders";

// Identity parsing (which issuer, which subject shape, where the profile
// lives) sits behind lib/identityProviders.ts. Everything in this module sees
// only the normalized Principal it returns. Re-exported for existing callers.
export { cliSubject, normalizeEmail };

// Permission tiers, ranked. Higher rank ⊇ the capabilities of every lower one.
// Derived from the schema's orgRole validator so the role enum has exactly one
// source of truth; roleRank's Record<OrgRole, ...> then forces a compile error
// here whenever a role is added there.
export type OrgRole = Infer<typeof orgRole>;

const roleRank: Record<OrgRole, number> = {
  [ORG_ROLE.VIEWER]: 0,
  [ORG_ROLE.MEMBER]: 1,
  [ORG_ROLE.ADMIN]: 2,
  [ORG_ROLE.OWNER]: 3,
};

// Whether org isolation is enforced on this deployment. Off by default so a
// single-user local install (no auth provider configured) keeps working
// exactly as before; flipped on by setting DFTSTREAM_AUTH_REQUIRED=1. Clients
// can probe the effective value via the public meta.version query.
//
// The parse is STRICT and fails CLOSED. This used to return true only for
// "1"/"true", which meant a typo ("TRUE", "yes", "on") silently disabled
// every gate on the deployment — the worst possible failure mode for the one
// switch that turns security on. Every gate evaluates through this function,
// so a malformed value now throws at the first gated call instead of quietly
// running the deployment wide open.
export function authEnabled(): boolean {
  const v = process.env.DFTSTREAM_AUTH_REQUIRED;
  if (v === undefined || v === "" || v === "0" || v === "false") return false;
  if (v === "1" || v === "true") return true;
  throw new Error(
    `DFTSTREAM_AUTH_REQUIRED=${JSON.stringify(v)} is not a valid value. ` +
      `Use "1" or "true" to enforce org isolation, or "0"/"false"/unset for ` +
      `local single-user mode. Refusing to guess: auth fails closed on a ` +
      `misconfigured flag.`,
  );
}

// --- Identity ---------------------------------------------------------------

// The single place provider identity is read. Returns the JWT identity or
// throws — never branches on which issuer (convex-auth / Clerk / DFTStream
// CLI) produced the token; they all populate ctx.auth uniformly.
export async function requireIdentity(ctx: QueryCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("not authenticated");
  return identity;
}

async function requirePrincipal(ctx: QueryCtx): Promise<Principal> {
  return principalOf(await requireIdentity(ctx));
}

// The org a CLI token is bound to, or null when the caller is a browser
// session. Enforced in requireMembership, the single choke point every org
// gate funnels through. Exported only for the two queries in organizations.ts
// that answer from `memberships` directly and so never reach
// requireMembership; nothing else should need it.
export async function cliTokenOrg(
  ctx: QueryCtx,
): Promise<Id<"organizations"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  const principal = principalOf(identity);
  if (principal.kind !== PRINCIPAL_KIND.CLI) return null;
  const orgId = ctx.db.normalizeId("organizations", principal.organizationId);
  // A scope we cannot resolve must never degrade to "unscoped".
  if (!orgId) throw new Error("CLI token carries an invalid organization scope");
  return orgId;
}

// Assert the caller is a human browser session, not a CLI token. Org
// administration and CLI-link approval require this: a CLI token is a
// long-lived bearer credential parked in a 0600 file on a shared submit host
// and exists to run jobs. Letting one mint further credentials, or change who
// is in the org, would turn a single leaked token into a permanent foothold.
export async function requireBrowserIdentity(ctx: QueryCtx): Promise<void> {
  if ((await requirePrincipal(ctx)).kind === PRINCIPAL_KIND.CLI) {
    throw new Error(
      "this operation requires a browser session, not a CLI token",
    );
  }
}

// Resolve the appUsers row a CLI principal names. normalizeId (rather than a
// bare cast) is what keeps a malformed subject from reaching ctx.db.get, which
// throws an opaque internal error on a non-id string.
async function cliAppUser(
  ctx: QueryCtx,
  appUserId: string,
): Promise<Doc<"appUsers"> | null> {
  const id = ctx.db.normalizeId("appUsers", appUserId);
  if (!id) throw new Error("CLI token references an unknown user");
  return await ctx.db.get(id);
}

// The appUsers row for an account principal's stable key.
async function accountAppUser(
  ctx: QueryCtx,
  accountKey: string,
): Promise<Doc<"appUsers"> | null> {
  return await ctx.db
    .query("appUsers")
    .withIndex("by_token", (q) => q.eq("tokenIdentifier", accountKey))
    .unique();
}

// Read-only profile lookup for the current caller, for display fallbacks (e.g.
// the `me` query) when the appUsers row hasn't been backfilled yet. Returns
// empty fields rather than throwing when unauthenticated.
export async function profileFallback(
  ctx: QueryCtx,
): Promise<{ email?: string; name?: string }> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return {};
  return await profileOf(ctx, identity);
}

// Read-only lookup of our provider-agnostic identity row. Returns null when the
// principal has never been provisioned (a brand-new user with no orgs yet) — so
// read queries can treat that as "no memberships" rather than an error.
export async function lookupAppUser(
  ctx: QueryCtx,
): Promise<Doc<"appUsers"> | null> {
  const principal = await requirePrincipal(ctx);
  return principal.kind === PRINCIPAL_KIND.CLI
    ? await cliAppUser(ctx, principal.appUserId)
    : await accountAppUser(ctx, principal.accountKey);
}

// The caller's appUsers row for the "who am I" style queries (myOrgs, myRole,
// me, listMine), which must answer a signed-out or no-auth caller with an
// empty result instead of an error. Returns null ONLY when there is no
// identity at all (or the principal has never been provisioned); every other
// failure — a CLI subject from an untrusted issuer, a malformed CLI subject, a
// database error — propagates. The old `lookupAppUser(ctx).catch(() => null)`
// idiom swallowed exactly those, turning a forgery attempt into a quiet "no
// orgs".
export async function maybeAppUser(
  ctx: QueryCtx,
): Promise<Doc<"appUsers"> | null> {
  if ((await ctx.auth.getUserIdentity()) === null) return null;
  return await lookupAppUser(ctx);
}

// How stale appUsers.lastSeenAt may get before currentUserId refreshes it.
// Coarse on purpose: the field feeds a human "does this look like the person
// you meant to invite" check, not an audit log, and a tighter granularity
// would put a row write on every authenticated mutation.
const LAST_SEEN_GRANULARITY_MS = 60 * 60 * 1000;

// Mutation-side identity: looks up the appUsers row, JIT-provisioning it on
// first write. This is where a new principal becomes a durable user record.
export async function currentUserId(
  ctx: MutationCtx,
): Promise<Id<"appUsers">> {
  const identity = await requireIdentity(ctx);
  const principal = principalOf(identity);
  if (principal.kind === PRINCIPAL_KIND.CLI) {
    // CLI tokens act AS an already-provisioned user; never create here.
    const row = await cliAppUser(ctx, principal.appUserId);
    if (!row) throw new Error("CLI token references an unknown user");
    return row._id;
  }
  const tokenIdentifier = principal.accountKey;
  const profile = await profileOf(ctx, identity);
  const existing = await accountAppUser(ctx, tokenIdentifier);
  if (existing) {
    // Backfill email/name once they become resolvable (the convex-auth JWT
    // carries neither at provision time, so the first row is often bare).
    const patch: Partial<Doc<"appUsers">> = {};
    if (!existing.email && profile.email) {
      patch.email = profile.email;
    } else if (existing.email) {
      // Self-heal rows written before emails were normalized on write — a
      // mixed-case stored email is invisible to addMember's exact-match index.
      const canonical = normalizeEmail(existing.email);
      if (canonical !== existing.email) patch.email = canonical;
    }
    if (!existing.name && profile.name) patch.name = profile.name;
    // Coarse "last signed-in activity" stamp, surfaced to admins reviewing an
    // invite candidate (organizations.addMember). Hour-granular so the hot
    // mutation path isn't rewriting this row on every call.
    const now = Date.now();
    if (
      existing.lastSeenAt === undefined ||
      now - existing.lastSeenAt > LAST_SEEN_GRANULARITY_MS
    ) {
      patch.lastSeenAt = now;
    }
    if (Object.keys(patch).length > 0) await ctx.db.patch(existing._id, patch);
    return existing._id;
  }
  return await ctx.db.insert("appUsers", {
    tokenIdentifier,
    email: profile.email,
    name: profile.name,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
  });
}

// --- Membership / roles -----------------------------------------------------

// Resolve the caller's membership in an org, or throw. Read-only: usable from
// queries and mutations (no JIT-provisioning — membership only exists if a
// mutation already created it).
export async function requireMembership(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
): Promise<Doc<"memberships">> {
  // Every org gate in the codebase funnels through here, which makes this the
  // one place CLI token scoping has to be enforced. A token approved for org A
  // is rejected for org B even though the human is a member of both.
  const scoped = await cliTokenOrg(ctx);
  if (scoped && scoped !== organizationId) {
    throw new Error("CLI token is not authorized for this organization");
  }
  const appUser = await lookupAppUser(ctx);
  const membership = appUser
    ? await ctx.db
        .query("memberships")
        .withIndex("by_user_org", (q) =>
          q.eq("appUserId", appUser._id).eq("organizationId", organizationId),
        )
        .unique()
    : null;
  if (!membership) throw new Error("not a member of this organization");
  return membership;
}

// Assert the caller belongs to at least ONE organization, without naming which.
// For the handful of operations that consume deployment resources but have no
// row to hang an org off yet — notably minting a file-storage upload URL. Bare
// `requireIdentity` is not enough there: anyone who can sign up (org creation
// is self-service) could otherwise upload unbounded blobs while belonging to
// nothing.
export async function requireAnyMembership(ctx: QueryCtx): Promise<void> {
  const appUser = await lookupAppUser(ctx);
  const membership = appUser
    ? await ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("appUserId", appUser._id))
        .first()
    : null;
  if (!membership) throw new Error("not a member of any organization");
}

// Assert the caller has at least `minRole` in the org. Returns the membership
// so callers can reuse the resolved role/appUserId.
export async function requireOrgRole(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  minRole: OrgRole,
): Promise<Doc<"memberships">> {
  const membership = await requireMembership(ctx, organizationId);
  if (roleRank[membership.role] < roleRank[minRole]) {
    throw new Error("insufficient permission");
  }
  return membership;
}

// "Members delete own": permit when the caller created the row, OR has role ≥
// admin in the owning org. `creatorUserId` may be undefined on legacy rows
// created before auth existed — those require admin.
export async function requireCanModify(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  creatorUserId: Id<"appUsers"> | undefined,
): Promise<Doc<"memberships">> {
  const membership = await requireMembership(ctx, organizationId);
  const isCreator =
    creatorUserId !== undefined && creatorUserId === membership.appUserId;
  if (!isCreator && roleRank[membership.role] < roleRank[ORG_ROLE.ADMIN]) {
    throw new Error("insufficient permission");
  }
  return membership;
}

// --- Authorization policy ---------------------------------------------------
//
// The gates below are the same questions asked under two policies, chosen
// once per call from DFTSTREAM_AUTH_REQUIRED:
//
//   LOCAL  auth off (single-user install): an implicit user who may do
//          everything. Every gate is a no-op and org-listing queries read the
//          deployment-wide index.
//   ORGS   auth on: org membership and role are enforced; every org-owned row
//          is re-resolved to its owning org first.
//
// Call sites use the exported gate* / authorize* / resolve* wrappers, never a
// policy object, so authzCoverage.test.ts can keep checking for a gate by
// name. Queries that pick a different DATA path with auth on (the org-scoped
// index versus the global one) still branch on authEnabled() themselves;
// resolveOrgScope covers the common listing case.

// Who is writing into an experiment, once authorized.
export type ExperimentWriter = {
  orgId: Id<"organizations">;
  userId: Id<"appUsers">;
};

export const AUTHZ_POLICY = { LOCAL: "local", ORGS: "orgs" } as const;
export type AuthzPolicyKind = (typeof AUTHZ_POLICY)[keyof typeof AUTHZ_POLICY];

interface AuthzPolicy {
  readonly kind: AuthzPolicyKind;
  runRead(ctx: QueryCtx, runId: Id<"runs">): Promise<void>;
  runWrite(ctx: QueryCtx, runId: Id<"runs">): Promise<void>;
  // "Members delete own" for a run: creator or admin+.
  runModify(ctx: QueryCtx, runId: Id<"runs">): Promise<void>;
  experimentRead(ctx: QueryCtx, experimentId: Id<"experiments">): Promise<void>;
  // "Members delete own" for a row hanging off an experiment (the experiment
  // itself, a batch, a pathway): creator or admin+ in the experiment's org.
  experimentRowModify(
    ctx: QueryCtx,
    experimentId: Id<"experiments">,
    creatorUserId: Id<"appUsers"> | undefined,
  ): Promise<void>;
  experimentWrite(
    ctx: MutationCtx,
    experimentId: Id<"experiments">,
  ): Promise<ExperimentWriter | null>;
  artifactRead(ctx: QueryCtx, artifactId: Id<"artifacts">): Promise<void>;
  artifactWrite(ctx: QueryCtx, artifactId: Id<"artifacts">): Promise<void>;
  pathwayRead(ctx: QueryCtx, pathwayId: Id<"pathways">): Promise<void>;
  anyMembership(ctx: QueryCtx): Promise<void>;
  orgScope(
    ctx: QueryCtx,
    organizationId: Id<"organizations"> | undefined,
    minRole: OrgRole,
  ): Promise<Id<"organizations"> | null>;
}

const allow = async (): Promise<void> => {};

const LOCAL_POLICY: AuthzPolicy = {
  kind: AUTHZ_POLICY.LOCAL,
  runRead: allow,
  runWrite: allow,
  runModify: allow,
  experimentRead: allow,
  experimentRowModify: allow,
  // No creator is stamped in single-user mode, exactly as before auth.
  experimentWrite: async () => null,
  artifactRead: allow,
  artifactWrite: allow,
  pathwayRead: allow,
  anyMembership: allow,
  // The argument is ignored; callers read the deployment-wide index.
  orgScope: async () => null,
};

const ORGS_POLICY: AuthzPolicy = {
  kind: AUTHZ_POLICY.ORGS,
  async runRead(ctx, runId) {
    await requireMembership(ctx, await orgOfRun(ctx, runId));
  },
  async runWrite(ctx, runId) {
    await requireOrgRole(ctx, await orgOfRun(ctx, runId), ORG_ROLE.MEMBER);
  },
  async runModify(ctx, runId) {
    await requireCanModifyRun(ctx, runId);
  },
  async experimentRead(ctx, experimentId) {
    await requireMembership(ctx, await orgOfExperiment(ctx, experimentId));
  },
  async experimentRowModify(ctx, experimentId, creatorUserId) {
    await requireCanModify(
      ctx,
      await orgOfExperiment(ctx, experimentId),
      creatorUserId,
    );
  },
  async experimentWrite(ctx, experimentId) {
    const orgId = await orgOfExperiment(ctx, experimentId);
    await requireOrgRole(ctx, orgId, ORG_ROLE.MEMBER);
    return { orgId, userId: await currentUserId(ctx) };
  },
  async artifactRead(ctx, artifactId) {
    await requireMembership(ctx, await orgOfArtifact(ctx, artifactId));
  },
  async artifactWrite(ctx, artifactId) {
    await requireOrgRole(ctx, await orgOfArtifact(ctx, artifactId), ORG_ROLE.MEMBER);
  },
  async pathwayRead(ctx, pathwayId) {
    await requireMembership(ctx, await orgOfPathway(ctx, pathwayId));
  },
  async anyMembership(ctx) {
    await requireAnyMembership(ctx);
  },
  async orgScope(ctx, organizationId, minRole) {
    // Authorize BEFORE any read so a non-member never triggers a scan.
    if (!organizationId) throw new Error("organization required");
    await requireOrgRole(ctx, organizationId, minRole);
    return organizationId;
  },
};

// The policy in force. Re-read per call (cheap: one env lookup) so a
// misconfigured flag throws at the first gated call, like authEnabled().
export function authzPolicy(): AuthzPolicy {
  return authEnabled() ? ORGS_POLICY : LOCAL_POLICY;
}

// --- Gates (what call sites use) ---------------------------------------------

// Writing run-child data (events/logs/metrics/geometries/frequencies/…) needs
// member+ in the run's org.
export async function gateRunWrite(ctx: QueryCtx, runId: Id<"runs">) {
  await authzPolicy().runWrite(ctx, runId);
}

// Reading run-child data needs membership in the run's org.
export async function gateRunRead(ctx: QueryCtx, runId: Id<"runs">) {
  await authzPolicy().runRead(ctx, runId);
}

// Renaming / deleting a run: its creator, or admin+ in its org.
export async function gateRunModify(ctx: QueryCtx, runId: Id<"runs">) {
  await authzPolicy().runModify(ctx, runId);
}

// Reading experiment-scoped data (run lists, batches, pathways, …) needs
// membership in the experiment's org. Mirrors gateRunRead one level up.
export async function gateExperimentRead(
  ctx: QueryCtx,
  experimentId: Id<"experiments">,
) {
  await authzPolicy().experimentRead(ctx, experimentId);
}

// Editing / deleting a row that hangs off an experiment (a batch, a pathway,
// the experiment itself): its creator, or admin+. A row with no recorded
// creator (pre-auth) requires admin.
export async function gateExperimentRowModify(
  ctx: QueryCtx,
  experimentId: Id<"experiments">,
  creatorUserId: Id<"appUsers"> | undefined,
) {
  await authzPolicy().experimentRowModify(ctx, experimentId, creatorUserId);
}

// Reading an artifact (its metadata or its body) needs membership in the org of
// the artifact's run. Shared by getContent and the /api/artifact body route's
// _bodyMeta, which must stay in lockstep.
export async function gateArtifactRead(
  ctx: QueryCtx,
  artifactId: Id<"artifacts">,
) {
  await authzPolicy().artifactRead(ctx, artifactId);
}

// Writing an existing artifact row needs member+ in its run's org.
export async function gateArtifactWrite(
  ctx: QueryCtx,
  artifactId: Id<"artifacts">,
) {
  await authzPolicy().artifactWrite(ctx, artifactId);
}

// Reading a pathway needs membership in its experiment's org.
export async function gatePathwayRead(ctx: QueryCtx, pathwayId: Id<"pathways">) {
  await authzPolicy().pathwayRead(ctx, pathwayId);
}

// Deployment resources with no row to hang an org off yet (upload URLs,
// migration kicks): the caller must belong to at least one org.
export async function gateAnyMembership(ctx: QueryCtx) {
  await authzPolicy().anyMembership(ctx);
}

// Creating a row under an experiment (a run, a batch, a pathway, a queued job)
// needs member+ in the experiment's org; the resolved org and the caller's
// appUsers id come back so the insert can stamp its creator. Returns null when
// auth is disabled — callers then write without a creator, exactly as before.
// Mutation-only: resolving the writer may JIT-provision the appUsers row.
export async function authorizeExperimentWrite(
  ctx: MutationCtx,
  experimentId: Id<"experiments">,
): Promise<ExperimentWriter | null> {
  return await authzPolicy().experimentWrite(ctx, experimentId);
}

// The org a list/lookup query is scoped to. With auth on, an organizationId is
// mandatory and the caller must hold at least `minRole` in it; the org comes
// back so the caller reads through its by_org index. With auth off it returns
// null and the caller reads the deployment-wide index instead — the argument
// is ignored, exactly as every such query always did in single-user mode.
export async function resolveOrgScope(
  ctx: QueryCtx,
  organizationId: Id<"organizations"> | undefined,
  minRole: OrgRole = ORG_ROLE.VIEWER,
): Promise<Id<"organizations"> | null> {
  return await authzPolicy().orgScope(ctx, organizationId, minRole);
}

// "Members delete own" for a run: resolve run → experiment → org and assert
// the caller created the run or holds admin+. Returns the run row so callers
// don't have to re-fetch it. Callers are responsible for the authEnabled()
// check (they typically have no-auth fallbacks of their own).
export async function requireCanModifyRun(
  ctx: QueryCtx,
  runId: Id<"runs">,
): Promise<Doc<"runs">> {
  const run = await ctx.db.get(runId);
  if (!run) throw new Error("run not found");
  const organizationId = await orgOfExperiment(ctx, run.experimentId);
  await requireCanModify(ctx, organizationId, run.submittedByUserId);
  return run;
}

// --- Org resolvers (the row → owning-org hops) ------------------------------

export async function orgOfExperiment(
  ctx: QueryCtx,
  experimentId: Id<"experiments">,
): Promise<Id<"organizations">> {
  const exp = await ctx.db.get(experimentId);
  if (!exp) throw new Error("experiment not found");
  if (!exp.organizationId) throw new Error("experiment has no organization");
  return exp.organizationId;
}

export async function orgOfRun(
  ctx: QueryCtx,
  runId: Id<"runs">,
): Promise<Id<"organizations">> {
  const run = await ctx.db.get(runId);
  if (!run) throw new Error("run not found");
  return await orgOfExperiment(ctx, run.experimentId);
}

export async function orgOfPathway(
  ctx: QueryCtx,
  pathwayId: Id<"pathways">,
): Promise<Id<"organizations">> {
  const pathway = await ctx.db.get(pathwayId);
  if (!pathway) throw new Error("pathway not found");
  return await orgOfExperiment(ctx, pathway.experimentId);
}

export async function orgOfArtifact(
  ctx: QueryCtx,
  artifactId: Id<"artifacts">,
): Promise<Id<"organizations">> {
  const artifact = await ctx.db.get(artifactId);
  if (!artifact) throw new Error("artifact not found");
  return await orgOfRun(ctx, artifact.runId);
}
