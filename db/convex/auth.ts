import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";

// convex-auth wiring for self-hosted / manual installs. Email+password is the
// lowest-friction flow that BOTH the browser and a headless Go client
// (`dftstream login`) can drive against /api/auth. Clerk deployments don't use
// any of this — they trust the Clerk issuer in auth.config.ts directly.
//
// Requires JWT_PRIVATE_KEY / JWKS / SITE_URL on the deployment (see
// `npx @convex-dev/auth`). Until those are set, getUserIdentity() returns null
// for convex-auth tokens and the org layer simply rejects as "not authenticated".
//
// SECURITY: this flow performs NO email verification — the address is whatever
// the signup form asserted. Nothing downstream may treat "account holds email
// X" as "account belongs to the owner of X": organizations.addMember therefore
// refuses to bind a membership to an account provisioned through this issuer
// without explicit admin confirmation (see docs/auth.md). If verification is
// ever added here, that confirmation step can be relaxed for verified rows.
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    // Relax the stock policy (which demands upper+lower+digit) to a plain
    // minimum length — appropriate for an internal lab tool. Throwing here
    // surfaces as "Invalid password" on the client.
    Password({
      // Capture a display name/username at sign-up (params.name from the
      // login form) alongside the email. Flows into the user doc and the
      // identity, so authz.currentUserId (via resolveProfile) stamps it onto
      // appUsers.
      profile(params) {
        const email = params.email as string;
        const name = params.name as string | undefined;
        // Omit name entirely when absent — a Convex document value may not be
        // `undefined`. Cast narrows away the optional-vs-index-signature clash.
        return (name ? { email, name } : { email }) as { email: string };
      },
      validatePasswordRequirements: (password: string) => {
        if (password.length < 8) {
          throw new Error("Password must be at least 8 characters");
        }
      },
    }),
  ],
});
