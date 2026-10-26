import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import {
  currentUserId,
  requireBrowserIdentity,
  requireOrgRole,
} from "./authz";
import { sha256HexSync } from "./lib/sha256";
import { ORG_ROLE } from "./schema";

// Org-scoped machine tokens: the non-interactive counterpart of the
// `dftstream login` browser-link flow (roadmap P0-2). A SLURM batch script
// cannot open a browser, so an org admin mints a long-lived secret in the
// settings UI, parks it in the DFTSTREAM_TOKEN environment variable, and the
// wrapper trades it for the SAME short-lived org-scoped `cli|` access token a
// browser-linked session gets — via POST /cli/token/exchange in http.ts.
//
// Trust model, deliberately simpler than cliLinks:
//   - The machine token itself IS the long-lived credential. There is no
//     refresh chain and nothing rotates: the CLI re-exchanges the same secret
//     on every startup and on any 401.
//   - Revocation therefore bites at the NEXT exchange. An outstanding access
//     token lives out its own ACCESS_TTL (1h), exactly like a revoked CLI
//     session's — see docs/auth.md.
//   - Only the sha256 digest of the secret is stored (like cliLinks refresh
//     tokens): a database leak alone cannot replay a token. The plaintext
//     leaves the backend exactly once, in `create`'s return value.
//   - Minting and revoking are browser-only admin operations. A CLI/machine
//     access token can neither create more machine tokens (credential
//     laundering) nor destroy the audit trail.

// Secret format: `ost_` + base64url of 32 random bytes (256 bits). The prefix
// makes a leaked token grep-able by secret scanners and unmistakable in an
// environment listing.
const TOKEN_PREFIX = "ost_";
const TOKEN_RANDOM_BYTES = 32;

// Server-side floor between accepted exchanges per token, mirroring
// cliLinks.MIN_POLL_INTERVAL_MS (RFC 8628 `slow_down`): a sprayed secret is
// rate-limited, while parallel batch jobs sharing one token recover by
// retrying — the refused attempt deliberately does NOT advance the window.
// Kept small because a SLURM array legitimately exchanges the same token once
// per task at job start.
const MIN_EXCHANGE_INTERVAL_MS = 250;

// Longest accepted token label. Purely a UI/storage sanity bound.
const MAX_NAME_LENGTH = 100;

// Bound on the settings-page listing; an org has no business holding more
// live machine tokens than this.
const LIST_LIMIT = 200;

function generateSecret(): string {
  const bytes = new Uint8Array(TOKEN_RANDOM_BYTES);
  crypto.getRandomValues(bytes);
  // base64url, no padding.
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return TOKEN_PREFIX + b64;
}

// Mint a machine token. Browser-only + admin, like every other
// credential-management mutation (organizations.addMember, cliLinks.approve):
// a leaked machine/CLI access token must not be able to mint fresh,
// independently-revocable credentials. Returns the plaintext secret exactly
// once — it is never stored and can never be shown again.
export const create = mutation({
  args: {
    organizationId: v.id("organizations"),
    name: v.string(),
  },
  handler: async (ctx, { organizationId, name }) => {
    await requireBrowserIdentity(ctx);
    await requireOrgRole(ctx, organizationId, ORG_ROLE.ADMIN);
    const label = name.trim();
    if (label.length === 0) throw new Error("token name must not be empty");
    if (label.length > MAX_NAME_LENGTH) {
      throw new Error(`token name must be at most ${MAX_NAME_LENGTH} characters`);
    }
    const createdByUserId = await currentUserId(ctx);
    const token = generateSecret();
    const tokenId = await ctx.db.insert("machineTokens", {
      organizationId,
      name: label,
      // Digest only — the plaintext exists solely in this return value.
      digest: sha256HexSync(token),
      createdByUserId,
      createdAt: Date.now(),
    });
    return { tokenId, name: label, token };
  },
});

// The org's machine tokens for the settings UI. Admin-gated: token metadata is
// operational security state, not something every member needs. Never returns
// the digest — nothing recoverable ever leaves this module.
export const list = query({
  args: { organizationId: v.id("organizations") },
  handler: async (ctx, { organizationId }) => {
    await requireOrgRole(ctx, organizationId, ORG_ROLE.ADMIN);
    const rows = await ctx.db
      .query("machineTokens")
      .withIndex("by_org", (q) => q.eq("organizationId", organizationId))
      .order("desc")
      .take(LIST_LIMIT);
    return rows.map((r) => ({
      tokenId: r._id,
      name: r.name,
      createdByUserId: r.createdByUserId,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt ?? null,
      revokedAt: r.revokedAt ?? null,
    }));
  },
});

// Kill a machine token. Browser-only + admin of the owning org. Idempotent —
// revoking twice is not an error. The next /cli/token/exchange gets HTTP 410;
// an outstanding access token dies at its own 1h expiry (documented as the
// revocation lag in docs/auth.md).
export const revoke = mutation({
  args: { tokenId: v.id("machineTokens") },
  handler: async (ctx, { tokenId }) => {
    // Browser sessions only: a machine token must not be able to revoke its
    // peers — or itself — and thereby tamper with the org's credential state.
    await requireBrowserIdentity(ctx);
    const row = await ctx.db.get(tokenId);
    if (!row) throw new Error("unknown machine token");
    await requireOrgRole(ctx, row.organizationId, ORG_ROLE.ADMIN);
    if (row.revokedAt !== undefined) return;
    await ctx.db.patch(tokenId, { revokedAt: Date.now() });
  },
});

// The validation half of POST /cli/token/exchange (http.ts hashes the
// presented secret and passes only the digest — this module never sees
// plaintext on the exchange path). A mutation so the same transaction that
// authorizes the exchange also stamps lastUsedAt, the only liveness signal
// the revoke UI has.
//
// Outcomes map to HTTP statuses in http.ts:
//   unknown   → 401 (also covers "creator lost membership": indistinguishable
//                on purpose, like cliLinks.redeemRefresh's uniform null)
//   revoked   → 410 (actionable: the operator deliberately killed it — the
//                fix is minting a new one, and the message can say so)
//   slow_down → 429 (throttle floor; does NOT advance the window, so a
//                compliant retry recovers immediately)
//   ok        → mint an access token for {appUserId, organizationId}
export const redeemExchange = internalMutation({
  args: { digest: v.string() },
  handler: async (
    ctx,
    { digest },
  ): Promise<
    | { outcome: "unknown" }
    | { outcome: "revoked" }
    | { outcome: "slow_down" }
    | { outcome: "ok"; appUserId: string; organizationId: string }
  > => {
    const row = await ctx.db
      .query("machineTokens")
      .withIndex("by_digest", (q) => q.eq("digest", digest))
      .unique();
    if (!row) return { outcome: "unknown" };
    if (row.revokedAt !== undefined) return { outcome: "revoked" };
    const now = Date.now();
    if (
      row.lastUsedAt !== undefined &&
      now - row.lastUsedAt < MIN_EXCHANGE_INTERVAL_MS
    ) {
      return { outcome: "slow_down" };
    }
    // Live membership of the minting admin is re-checked on every exchange,
    // mirroring cliLinks.redeemRefresh: the minted access token acts as that
    // user in that org, so an offboarded creator's tokens must stop working
    // here — within ACCESS_TTL of their removal. (Consequence, documented in
    // docs/auth.md: tokens die with their creator's membership; a departing
    // admin's tokens must be re-minted by a current admin.)
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_user_org", (q) =>
        q
          .eq("appUserId", row.createdByUserId)
          .eq("organizationId", row.organizationId),
      )
      .unique();
    if (!membership) return { outcome: "unknown" };
    await ctx.db.patch(row._id, { lastUsedAt: now });
    return {
      outcome: "ok",
      appUserId: row.createdByUserId,
      organizationId: row.organizationId,
    };
  },
});
