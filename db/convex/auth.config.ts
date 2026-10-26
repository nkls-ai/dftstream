import { authConfigProviders } from "./lib/authIssuers";

// Trusted JWT issuers, assembled from deploy-time env so a single codebase can
// run in either mode. Convex fetches `{domain}/.well-known/openid-configuration`
// per provider and checks the JWT `aud` against `applicationID`.
//
//   - convex-auth  → present when the deployment site URL is set (self-hosted /
//                    manual installs). Its issuer is the deployment's own site.
//   - Clerk        → present when CLERK_JWT_ISSUER_DOMAIN is set (business /
//                    hosted teams). Independent of convex-auth: a deployment can
//                    trust convex-auth, Clerk, both, or neither (no-auth mode).
//   - DFTStream   → the CLI token issuer (rides the site URL); backs the
//     CLI            `dftstream login` browser-link flow for BOTH providers,
//                    minted in http.ts and signed with the same deployment JWT
//                    key convex-auth uses.
//
// The list itself comes from the provider registry in lib/authIssuers.ts. The
// env reads stay HERE, literally: Convex refuses a push when a variable this
// file names is unset (see docs/auth.md),
// and that check must keep seeing both names.
//
// The UI's `authProvider` in /dftstream-config.json picks which login surface
// to show; this file decides which issuers the backend trusts. Identity never
// branches on which issued the token outside lib/identityProviders.ts.
export default {
  providers: authConfigProviders({
    siteUrl: process.env.CONVEX_SITE_URL,
    clerkIssuerDomain: process.env.CLERK_JWT_ISSUER_DOMAIN,
  }),
};
