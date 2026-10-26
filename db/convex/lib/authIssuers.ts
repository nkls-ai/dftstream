// The one registry of identity providers this deployment knows about, and the
// JWT issuers each one contributes to auth.config.ts.
//
// Pure data + pure functions on purpose: auth.config.ts imports this, and that
// file is evaluated at push time with nothing but the deployment env — so no
// ctx, no database, no generated server code here. The runtime half (mapping a
// verified identity to a principal) lives in lib/identityProviders.ts.
//
// Adding a provider: give it a kind below, an issuer entry in ISSUERS (if it
// brings its own JWT issuer), and an IdentityProvider in identityProviders.ts.

export const IDENTITY_PROVIDER = {
  // convex-auth Password flow; issuer = the deployment's own site URL.
  CONVEX_AUTH: "convex-auth",
  // Clerk; issuer = CLERK_JWT_ISSUER_DOMAIN.
  CLERK: "clerk",
  // DFTStream CLI access tokens (browser-link login AND machine-token
  // exchange mint the same token), signed by http.ts with the deployment key;
  // issuer = the deployment's own site URL, subject prefixed `cli|`.
  CLI: "dftstream-cli",
  // Any other issuer an operator adds to auth.config.ts by hand. Treated like
  // Clerk: its email claims are assumed verified (docs/auth.md).
  EXTERNAL: "external-oidc",
} as const;

export type IdentityProviderKind =
  (typeof IDENTITY_PROVIDER)[keyof typeof IDENTITY_PROVIDER];

// Convex checks a JWT's `aud` against this for every trusted issuer; http.ts
// signs CLI tokens with the same audience.
export const CONVEX_APPLICATION_ID = "convex";

// The deployment configuration the issuer list depends on. auth.config.ts
// reads process.env itself and passes the values in, so the env names stay
// visible to Convex's push-time check of that file.
export type IssuerEnv = {
  siteUrl: string | undefined;
  clerkIssuerDomain: string | undefined;
};

export type AuthConfigProvider = { domain: string; applicationID: string };

// Which provider brings which issuer. The CLI issuer is the site URL too, so
// it rides the convex-auth entry: trusting the site URL trusts both.
const ISSUERS: ReadonlyArray<{
  kind: IdentityProviderKind;
  issuer: (env: IssuerEnv) => string | undefined;
}> = [
  { kind: IDENTITY_PROVIDER.CONVEX_AUTH, issuer: (env) => env.siteUrl },
  { kind: IDENTITY_PROVIDER.CLERK, issuer: (env) => env.clerkIssuerDomain },
];

// The `providers` list for auth.config.ts: one entry per configured issuer,
// in registry order, empty values skipped (so a no-auth deployment trusts
// nothing and a convex-auth-only one never references Clerk).
export function authConfigProviders(env: IssuerEnv): AuthConfigProvider[] {
  const out: AuthConfigProvider[] = [];
  for (const { issuer } of ISSUERS) {
    const domain = issuer(env);
    if (!domain || out.some((p) => p.domain === domain)) continue;
    out.push({ domain, applicationID: CONVEX_APPLICATION_ID });
  }
  return out;
}

// The same configuration as seen by running functions.
export function runtimeIssuerEnv(): IssuerEnv {
  return {
    siteUrl: process.env.CONVEX_SITE_URL,
    clerkIssuerDomain: process.env.CLERK_JWT_ISSUER_DOMAIN,
  };
}
