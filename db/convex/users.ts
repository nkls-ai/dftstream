import { mutation, query } from "./_generated/server";
import { currentUserId, maybeAppUser, profileFallback } from "./authz";

// Provision (or fetch) the caller's appUsers row. The UI calls this right after
// authentication so the principal becomes a durable record — which is what lets
// an admin later add them to an org by email. Returns the appUsers id.
export const ensureSelf = mutation({
  args: {},
  handler: async (ctx) => {
    return await currentUserId(ctx);
  },
});

// The caller's own identity row, or null if unauthenticated / not yet
// provisioned. Used by the UI to show the account chip.
export const me = query({
  args: {},
  handler: async (ctx) => {
    const user = await maybeAppUser(ctx);
    if (!user) return null;
    // appUsers may not have the email yet (convex-auth provisions it bare and
    // backfills on the next ensureSelf). Fall back to the provider profile so
    // the account chip is never a stray "—".
    const fallback = await profileFallback(ctx);
    return {
      _id: user._id,
      email: user.email ?? fallback.email ?? null,
      name: user.name ?? fallback.name ?? null,
    };
  },
});
