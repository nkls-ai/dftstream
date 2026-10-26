import { v } from "convex/values";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { CLI_LINK_STATUS, ORG_ROLE } from "./schema";
import {
  currentUserId,
  lookupAppUser,
  maybeAppUser,
  requireBrowserIdentity,
  requireMembership,
  requireOrgRole,
} from "./authz";

// Backs the `dftstream login` browser-link flow, shaped after RFC 8628
// (device authorization grant). Two values exist per handshake:
//
//   device code  (`code`)     — high-entropy secret held only by the CLI. It
//                               never appears in a URL; polling and token
//                               issuance require it.
//   user code    (`userCode`) — short code shown to the human and carried in
//                               the browser verify URL. It can only TARGET an
//                               approval by a signed-in member; it can never
//                               yield tokens. A bystander who sees the URL
//                               (screen share, proxy log, browser history)
//                               learns nothing they can redeem.
//
// The CLI starts a link, the signed-in UI approves the user code (binding the
// caller + chosen org), and the CLI polls with the device code until it can
// mint a token. See http.ts for the HTTP surface, which also does all secret
// generation and hashing — this module only ever sees and stores sha256
// digests of refresh tokens, never the plaintext.
//
// Lifetimes, and why:
//   LINK_TTL_MS      the PENDING→APPROVED→CONSUMED handshake window. This is
//                    the device-code phishing window: an attacker who starts a
//                    link and talks a victim into approving it walks away with
//                    a token acting as that victim. Keeping it short is the
//                    standard mitigation (RFC 8628 recommends minutes).
//   REFRESH_TTL_MS   absolute ceiling on a CLI session. The access token lasts
//                    an hour, but the refresh token mints new ones; without a
//                    ceiling a credential copied off a submit host is good
//                    forever.
const LINK_TTL_MS = 10 * 60 * 1000; // 10 minutes
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Expired handshake rows swept per /cli/link/start call. That endpoint needs no
// credential, so its rows must not accumulate; a small bounded sweep amortizes
// the cleanup without ever blowing the transaction budget. crons.ts runs the
// same sweep with a larger batch so a burst of starts (or a quiet deployment
// that never sees another start) cannot leave rows behind.
const SWEEP_BATCH = 10;
const CRON_SWEEP_BATCH = 200;

// Throttling for the unauthenticated surface:
//   MIN_POLL_INTERVAL_MS  server-side floor between accepted polls per code
//                         (RFC 8628 `slow_down`). The CLI polls every 3 s.
//   MAX_POLLS             hard cap on polls per handshake; past it the row is
//                         dead even inside its time window.
//   MAX_PENDING_LINKS     cap on outstanding pending handshakes, so a burst of
//                         anonymous /cli/link/start calls cannot grow the
//                         table faster than the sweep drains it.
const MIN_POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 300;
const MAX_PENDING_LINKS = 100;

// Concurrent-refresh grace: parallel `dftstream run` invocations share one
// credentials.json, so two of them can race a refresh with the same token.
// Within this window after a rotation, the superseded token is still honored
// (without minting another rotation); after it, presenting the superseded
// token is treated as replay of a stolen credential and revokes the link.
const ROTATION_GRACE_MS = 60 * 1000;

// Canonical form of a user code, applied both when a handshake is stored and
// when a human types (or pastes) the code into the approval screen. People
// retype what the terminal shows: lowercase, without the dash, with stray
// spaces. Those used to fail as "unknown link code". http.ts generates codes
// as XXXX-XXXX from an uppercase alphabet, so: uppercase, keep only [A-Z0-9],
// and re-insert the dash for an 8-character code.
const USER_CODE_GROUP = 4;
export function normalizeUserCode(input: string): string {
  const bare = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return bare.length === USER_CODE_GROUP * 2
    ? `${bare.slice(0, USER_CODE_GROUP)}-${bare.slice(USER_CODE_GROUP)}`
    : bare;
}

function isLive(link: Doc<"cliLinks">, now: number): boolean {
  // An absent expiresAt is a row written before expiry existed. Fail closed.
  return link.expiresAt !== undefined && link.expiresAt > now;
}

export const start = internalMutation({
  args: {
    // The device code (secret, CLI-held).
    code: v.string(),
    // The short human-facing code. Optional so callers that predate the
    // device/user split (the authz lifecycle tests) can drive the state
    // machine with a single value for both; http.ts always passes a distinct
    // short userCode.
    userCode: v.optional(v.string()),
  },
  handler: async (ctx, { code, userCode }) => {
    const now = Date.now();
    await sweepExpired(ctx, now, SWEEP_BATCH);
    // Cap outstanding pending handshakes AFTER sweeping, so expired rows never
    // wedge the endpoint shut. Anonymous callers share this budget; hitting it
    // surfaces as HTTP 429 from /cli/link/start.
    const pending = await ctx.db
      .query("cliLinks")
      .withIndex("by_status_expiresAt", (q) =>
        q.eq("status", CLI_LINK_STATUS.PENDING),
      )
      .take(MAX_PENDING_LINKS);
    if (pending.length >= MAX_PENDING_LINKS) return null;
    return await ctx.db.insert("cliLinks", {
      code,
      userCode: normalizeUserCode(userCode ?? code),
      status: CLI_LINK_STATUS.PENDING,
      createdAt: now,
      expiresAt: now + LINK_TTL_MS,
    });
  },
});

// sweepExpired drops abandoned handshake rows (started or approved but never
// picked up). CONSUMED rows are left alone — those are live CLI sessions and
// are governed by refreshExpiresAt/revokedAt instead.
async function sweepExpired(
  ctx: MutationCtx,
  now: number,
  batch: number,
): Promise<void> {
  for (const status of [CLI_LINK_STATUS.PENDING, CLI_LINK_STATUS.APPROVED]) {
    const stale = await ctx.db
      .query("cliLinks")
      .withIndex("by_status_expiresAt", (q) =>
        q.eq("status", status).lt("expiresAt", now),
      )
      .take(batch);
    for (const row of stale) await ctx.db.delete(row._id);
  }
}

// Cron entry point (see crons.ts): the same sweep start amortizes, but with a
// batch large enough to drain a burst of anonymous starts even if no further
// start ever arrives.
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    await sweepExpired(ctx, now, CRON_SWEEP_BATCH);
    await sweepDeadSessions(ctx, now, CRON_SWEEP_BATCH);
  },
});

// Consumed sessions past their absolute refresh ceiling are dead weight: no
// token they ever issued can refresh again, and listMine already hides them.
// They used to stay forever — one row per login, per user, per org. A
// consumed row's handshake `expiresAt` precedes its consume time, so
// refreshExpiresAt <= expiresAt + REFRESH_TTL_MS: every row whose expiresAt
// is more than REFRESH_TTL_MS old is past its ceiling, and the existing
// by_status_expiresAt index finds them without a new index.
async function sweepDeadSessions(
  ctx: MutationCtx,
  now: number,
  batch: number,
): Promise<void> {
  const dead = await ctx.db
    .query("cliLinks")
    .withIndex("by_status_expiresAt", (q) =>
      q
        .eq("status", CLI_LINK_STATUS.CONSUMED)
        .lt("expiresAt", now - REFRESH_TTL_MS - LINK_TTL_MS),
    )
    .take(batch);
  for (const row of dead) await ctx.db.delete(row._id);
}

// registerPoll is the read half of /cli/link/poll, made a mutation so the same
// transaction that answers also stamps the throttle state. It looks the row up
// by DEVICE code only — the user code deliberately has no path to this
// function — and enforces the RFC 8628 `slow_down` contract: polls faster than
// MIN_POLL_INTERVAL_MS are refused without advancing the window, and a
// handshake that polls more than MAX_POLLS times is dead for good.
export const registerPoll = internalMutation({
  args: { code: v.string() },
  handler: async (
    ctx,
    { code },
  ): Promise<
    | { outcome: "unknown" }
    | { outcome: "slow_down" }
    | { outcome: "expired" }
    | { outcome: "pending" }
    | { outcome: "consumed" }
    | { outcome: "approved" }
  > => {
    const link = await ctx.db
      .query("cliLinks")
      .withIndex("by_code", (q) => q.eq("code", code))
      .unique();
    if (!link) return { outcome: "unknown" };
    if (link.status === CLI_LINK_STATUS.CONSUMED) {
      return { outcome: "consumed" };
    }
    const now = Date.now();
    if (!isLive(link, now)) return { outcome: "expired" };
    const polls = link.pollCount ?? 0;
    if (polls >= MAX_POLLS) {
      // Someone is hammering a code they should have redeemed long ago.
      // Kill the handshake rather than let it be brute-forced against.
      await ctx.db.delete(link._id);
      return { outcome: "expired" };
    }
    if (
      link.lastPollAt !== undefined &&
      now - link.lastPollAt < MIN_POLL_INTERVAL_MS
    ) {
      // Deliberately does NOT stamp lastPollAt: a client that backs off to
      // the correct interval recovers immediately instead of being throttled
      // forever by its own retries.
      return { outcome: "slow_down" };
    }
    await ctx.db.patch(link._id, { lastPollAt: now, pollCount: polls + 1 });
    return link.status === CLI_LINK_STATUS.APPROVED
      ? { outcome: "approved" }
      : { outcome: "pending" };
  },
});

// redeemRefresh validates a refresh token digest and returns the identity to
// mint an access token for, rotating the stored digest to `nextRefreshToken`
// (also a digest, minted by the /cli/link/refresh action — this mutation never
// sees plaintext). A mutation rather than a query so the same transaction that
// authorizes the refresh also rotates and stamps lastUsedAt — the value the
// revoke UI shows and the only signal an operator has that a stolen credential
// is in use.
//
// Reuse detection: after a rotation the superseded digest is kept in
// prevRefreshToken. Presenting it again within ROTATION_GRACE_MS is a
// legitimate concurrent refresh (parallel jobs sharing credentials.json) and
// is answered without another rotation; presenting it later means two parties
// hold the credential — the classic stolen-refresh-token signature — and the
// whole link is revoked so BOTH parties lose.
//
// Returns null (never a reason) for every rejection: a caller holding a bad
// token learns nothing about why.
export const redeemRefresh = internalMutation({
  args: {
    refreshToken: v.string(),
    // Digest to rotate to. Optional so internal callers (the authz lifecycle
    // tests) can validate without rotating; /cli/link/refresh always rotates.
    nextRefreshToken: v.optional(v.string()),
  },
  handler: async (ctx, { refreshToken, nextRefreshToken }) => {
    const now = Date.now();
    let link = await ctx.db
      .query("cliLinks")
      .withIndex("by_refresh", (q) => q.eq("refreshToken", refreshToken))
      .unique();
    let supersededReplay = false;
    if (!link) {
      const prev = await ctx.db
        .query("cliLinks")
        .withIndex("by_prev_refresh", (q) =>
          q.eq("prevRefreshToken", refreshToken),
        )
        .unique();
      if (!prev) return null;
      const withinGrace =
        prev.rotatedAt !== undefined && now - prev.rotatedAt <= ROTATION_GRACE_MS;
      if (!withinGrace) {
        // Replay of a rotated-out token: someone else already spent it. Treat
        // the credential as compromised and kill the entire chain.
        if (prev.revokedAt === undefined) {
          await ctx.db.patch(prev._id, { revokedAt: now });
        }
        return null;
      }
      link = prev;
      supersededReplay = true;
    }
    const appUserId = link.appUserId;
    const organizationId = link.organizationId;
    if (!appUserId || !organizationId) return null;
    if (link.revokedAt !== undefined) return null;
    // Absent refreshExpiresAt = pre-expiry row; fail closed like isLive.
    if (link.refreshExpiresAt === undefined || link.refreshExpiresAt <= now) {
      return null;
    }
    // The membership is re-checked on every refresh, not just at approval: a
    // user removed from the org must stop being able to mint tokens for it,
    // and the access token itself carries no membership proof. This is what
    // bounds an offboarded member's CLI to one ACCESS_TTL.
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_user_org", (q) =>
        q.eq("appUserId", appUserId).eq("organizationId", organizationId),
      )
      .unique();
    if (!membership) return null;
    if (nextRefreshToken !== undefined && !supersededReplay) {
      await ctx.db.patch(link._id, {
        refreshToken: nextRefreshToken,
        prevRefreshToken: link.refreshToken,
        rotatedAt: now,
        lastUsedAt: now,
      });
    } else {
      // In-grace concurrent refresh (or a non-rotating internal caller): keep
      // the current digest so the party that won the rotation stays valid.
      await ctx.db.patch(link._id, { lastUsedAt: now });
    }
    return { appUserId, organizationId, rotated: nextRefreshToken !== undefined && !supersededReplay };
  },
});

// Called from the UI (authenticated). Keyed on the USER code — the value the
// human sees in the verify URL — and binds the link to the caller + the org
// they picked, so the minted CLI token acts as that user in that org. Knowing
// the user code grants exactly this and nothing more; the tokens themselves
// only ever go to the holder of the device code.
export const approve = mutation({
  args: { code: v.string(), organizationId: v.id("organizations") },
  handler: async (ctx, { code, organizationId }) => {
    // Browser sessions only. A CLI token approving a link would let a leaked
    // credential mint fresh, independently-revocable credentials — laundering
    // a one-hour theft into a permanent one.
    await requireBrowserIdentity(ctx);
    // collect() rather than unique(): the user code is short, so a collision
    // with another live handshake is theoretically possible and must fail the
    // approval, not crash it into an opaque server error.
    const matches = await ctx.db
      .query("cliLinks")
      .withIndex("by_user_code", (q) =>
        q.eq("userCode", normalizeUserCode(code)),
      )
      .collect();
    if (matches.length === 0) throw new Error("unknown link code");
    if (matches.length > 1) {
      throw new Error("ambiguous link code — run `dftstream login` again");
    }
    const link = matches[0]!;
    // Single-transition state machine: an already-approved link must not be
    // re-bound to a different caller/org before the CLI consumes it.
    if (link.status !== CLI_LINK_STATUS.PENDING) {
      throw new Error("link already used");
    }
    const now = Date.now();
    if (!isLive(link, now)) throw new Error("link code has expired");
    await requireMembership(ctx, organizationId);
    const appUserId = await currentUserId(ctx);
    await ctx.db.patch(link._id, {
      status: CLI_LINK_STATUS.APPROVED,
      appUserId,
      organizationId,
      // Fresh window for the CLI's next poll, so approving late in the
      // original window doesn't race the CLI out of a token.
      expiresAt: now + LINK_TTL_MS,
    });
  },
});

// Called from the poll HTTP action once approved: records the refresh secret's
// digest (hashed by http.ts — the plaintext never reaches the database) and
// flips the link to consumed. Keyed on the DEVICE code: approval by user code
// is worthless to anyone who cannot also present this. Returns the bound
// identity for token minting.
export const consume = internalMutation({
  args: { code: v.string(), refreshToken: v.string() },
  handler: async (ctx, { code, refreshToken }) => {
    const link = await ctx.db
      .query("cliLinks")
      .withIndex("by_code", (q) => q.eq("code", code))
      .unique();
    if (!link || link.status !== CLI_LINK_STATUS.APPROVED) return null;
    // Revoked between approval and pickup (the approver was removed from the
    // org): the handshake yields nothing.
    if (link.revokedAt !== undefined) return null;
    const now = Date.now();
    if (!isLive(link, now)) return null;
    await ctx.db.patch(link._id, {
      status: CLI_LINK_STATUS.CONSUMED,
      // The handshake is over; retiring the user code frees it from ever
      // colliding with a future handshake's short-code space.
      userCode: undefined,
      refreshToken,
      rotatedAt: now,
      refreshExpiresAt: now + REFRESH_TTL_MS,
      lastUsedAt: now,
    });
    // The org's display name and slug ride along so `dftstream login` can
    // say which org it now acts in, as the approval page did.
    const org = link.organizationId
      ? await ctx.db.get(link.organizationId)
      : null;
    return {
      appUserId: link.appUserId ?? null,
      organizationId: link.organizationId ?? null,
      organizationName: org?.name ?? null,
      organizationSlug: org?.slug ?? null,
    };
  },
});

// --- session management -----------------------------------------------------

// The caller's live CLI sessions. Never returns the refresh token digest —
// the plaintext secret leaves the backend exactly once per rotation, in the
// /cli/link/poll and /cli/link/refresh responses.
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    // Unauthenticated or not-yet-provisioned callers simply have no sessions:
    // surfacing an error would break the account screen on first paint. Any
    // OTHER failure (a forged CLI subject, a db error) still propagates.
    const user = await maybeAppUser(ctx);
    if (!user) return [];
    const now = Date.now();
    const rows = await ctx.db
      .query("cliLinks")
      .withIndex("by_user", (q) => q.eq("appUserId", user._id))
      .collect();
    return rows
      .filter(
        (r) =>
          r.status === CLI_LINK_STATUS.CONSUMED &&
          r.revokedAt === undefined &&
          (r.refreshExpiresAt ?? 0) > now,
      )
      .map((r) => ({
        linkId: r._id,
        organizationId: r.organizationId ?? null,
        createdAt: r.createdAt,
        lastUsedAt: r.lastUsedAt ?? null,
        expiresAt: r.refreshExpiresAt ?? null,
      }));
  },
});

// Kill a CLI session. The session's own user may always revoke it; so may an
// admin+ of the org it is bound to, which is what makes offboarding possible
// without the departing member's cooperation. The outstanding access token
// still works until its own 1h expiry — bounding that is the ACCESS_TTL's job.
export const revoke = mutation({
  args: { linkId: v.id("cliLinks") },
  handler: async (ctx, { linkId }) => {
    // Browser sessions only, like every other credential-management mutation:
    // a leaked CLI token must not be able to tamper with the session table —
    // not even "just" to revoke, which would let a token holder kill a
    // colleague's sessions (via the admin path) or destroy the evidence trail
    // (lastUsedAt stops advancing once its own session is dead).
    await requireBrowserIdentity(ctx);
    const link = await ctx.db.get(linkId);
    if (!link) throw new Error("unknown CLI session");
    const user = await lookupAppUser(ctx);
    const isOwnSession = user !== null && link.appUserId === user._id;
    if (!isOwnSession) {
      if (!link.organizationId) {
        throw new Error("insufficient permission");
      }
      await requireOrgRole(ctx, link.organizationId, ORG_ROLE.ADMIN);
    }
    if (link.revokedAt !== undefined) return;
    await ctx.db.patch(linkId, { revokedAt: Date.now() });
  },
});
