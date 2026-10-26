import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

// Credentials issued FOR an org membership (CLI sessions approved into the
// org, machine tokens minted in it) must die with that membership for good.
//
// redeemRefresh and redeemExchange already refuse while the user is not a
// member, but that check is live: re-adding the same person — a routine
// "removed by mistake" or a returning student — silently revived every
// session and machine token they held before, including one that leaked in
// the meantime. Removal now revokes them outright, so a re-added member
// starts from zero credentials.

// Revoke every CLI session `appUserId` holds in `organizationId` and every
// machine token they minted there. Idempotent.
export async function revokeMemberCredentials(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  appUserId: Id<"appUsers">,
): Promise<void> {
  const now = Date.now();
  const links = await ctx.db
    .query("cliLinks")
    .withIndex("by_user", (q) => q.eq("appUserId", appUserId))
    .collect();
  for (const link of links) {
    // Covers approved-but-not-yet-polled handshakes too: consume refuses a
    // revoked link, so the CLI cannot collect a token after the removal.
    if (link.organizationId === organizationId && link.revokedAt === undefined) {
      await ctx.db.patch(link._id, { revokedAt: now });
    }
  }
  const tokens = await ctx.db
    .query("machineTokens")
    .withIndex("by_org", (q) => q.eq("organizationId", organizationId))
    .collect();
  for (const token of tokens) {
    if (token.createdByUserId === appUserId && token.revokedAt === undefined) {
      await ctx.db.patch(token._id, { revokedAt: now });
    }
  }
}

// An org is being deleted: its machine tokens go with it (nothing can list or
// revoke them once the org is gone), and every member's CLI sessions for it
// are revoked so they drop off the sessions list instead of pointing at a
// missing org.
export async function removeOrgCredentials(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  memberIds: readonly Id<"appUsers">[],
): Promise<void> {
  for (const appUserId of memberIds) {
    await revokeMemberCredentials(ctx, organizationId, appUserId);
  }
  const tokens = await ctx.db
    .query("machineTokens")
    .withIndex("by_org", (q) => q.eq("organizationId", organizationId))
    .collect();
  for (const token of tokens) await ctx.db.delete(token._id);
}
