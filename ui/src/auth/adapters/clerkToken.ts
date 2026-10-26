// Which getToken() options yield the Convex-audience JWT from Clerk. Kept in
// lockstep with convex/react-clerk's ConvexProviderWithClerk, which sends:
//   - the session token itself when it already carries aud "convex" (Clerk's
//     native Convex integration — no JWT template exists), else
//   - the "convex" JWT template (the older template-based setup).
// Always asking for the template (as this app used to) fails under the native
// integration, so the authenticated /api/artifact fetch got no token and every
// artifact body 401'd while the rest of the app worked.

export const CONVEX_AUDIENCE = "convex";
export const CONVEX_JWT_TEMPLATE = "convex";

export type ClerkTokenOptions = { template?: string };

export function clerkTokenOptions(sessionAudience: unknown): ClerkTokenOptions {
  // Strict equality, exactly as ConvexProviderWithClerk decides.
  return sessionAudience === CONVEX_AUDIENCE ? {} : { template: CONVEX_JWT_TEMPLATE };
}
