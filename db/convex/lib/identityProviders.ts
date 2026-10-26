import type { QueryCtx } from "../_generated/server";
import {
  IDENTITY_PROVIDER,
  runtimeIssuerEnv,
  type IdentityProviderKind,
  type IssuerEnv,
} from "./authIssuers";

// Identity resolution behind one interface. Every JWT Convex has verified is
// handed to exactly one IdentityProvider, which maps it to a normalized
// Principal. authz.ts (and through it every gate) depends only on Principal —
// never on which issuer produced the token or how its subject is shaped.
//
// Adding a provider: add its kind + issuer to lib/authIssuers.ts, implement
// IdentityProvider here, and insert it into PROVIDERS ahead of the EXTERNAL
// catch-all.

// The verified JWT claims we read. A subset of Convex's UserIdentity.
export type JwtIdentity = {
  issuer: string;
  subject: string;
  email?: string;
  name?: string;
};

export type Profile = { email?: string; name?: string };

export const PRINCIPAL_KIND = {
  // A human account from a login provider (convex-auth, Clerk, …). Resolved
  // to an appUsers row by `accountKey`, JIT-provisioned on first write.
  ACCOUNT: "account",
  // A DFTStream CLI access token: acts as an existing appUsers row, bound to
  // exactly one organization, never provisions anything.
  CLI: "cli",
} as const;

export type Principal =
  | {
      kind: typeof PRINCIPAL_KIND.ACCOUNT;
      provider: IdentityProviderKind;
      // STABLE per-account key (issuer + user id, no session id) — the
      // appUsers.by_token value.
      accountKey: string;
    }
  | {
      kind: typeof PRINCIPAL_KIND.CLI;
      provider: typeof IDENTITY_PROVIDER.CLI;
      appUserId: string;
      organizationId: string;
    };

export interface IdentityProvider {
  readonly kind: IdentityProviderKind;
  // Whether this provider's emails were verified by the provider itself. Only
  // meaningful for ACCOUNT principals; organizations.addMember refuses to
  // bind a membership to an unverified email without admin confirmation.
  readonly emailVerified: boolean;
  // Whether this provider owns the verified identity. Evaluated in PROVIDERS
  // order; the first match wins.
  claims(identity: JwtIdentity, env: IssuerEnv): boolean;
  // Whether an appUsers.tokenIdentifier (an ACCOUNT principal's accountKey)
  // was minted by this provider.
  ownsAccountKey(accountKey: string, env: IssuerEnv): boolean;
  // Map the identity to a principal. Throws on a malformed or forged token.
  principal(identity: JwtIdentity, env: IssuerEnv): Principal;
  // Email/name to stamp onto appUsers, emails normalized.
  profile(ctx: QueryCtx, identity: JwtIdentity, env: IssuerEnv): Promise<Profile>;
}

// Canonical form for every email we store or match on: trimmed and lowercased.
// appUsers.by_email and orgInvites.by_org_email are exact-match indexes, so a
// mixed-case write would make the row unmatchable by organizations.addMember.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Divider inside JWT subjects: convex-auth writes `${userId}|${sessionId}`,
// http.ts writes `cli|${appUserId}|${orgId}`.
const SUBJECT_DIVIDER = "|";

// Subject prefix marking a DFTStream CLI token.
const CLI_SUBJECT_PREFIX = `cli${SUBJECT_DIVIDER}`;

// cliSubject builds the `sub` claim http.ts signs into a CLI access token. The
// organization is part of the SUBJECT, not a side-channel: it is what bounds
// the token to the single org the human approved in the browser (or the org a
// machine token was minted for).
export function cliSubject(appUserId: string, organizationId: string): string {
  return `${CLI_SUBJECT_PREFIX}${appUserId}${SUBJECT_DIVIDER}${organizationId}`;
}

// The STABLE per-account key. convex-auth's subject is `${userId}|${sessionId}`
// and the sessionId rotates on every login, so keying appUsers off the raw
// tokenIdentifier would mint a brand-new row each sign-in. Strip everything
// after the first divider; issuers whose subject has none (Clerk) are
// unchanged.
function accountKeyOf(identity: JwtIdentity): string {
  const userId = identity.subject.split(SUBJECT_DIVIDER)[0];
  return `${identity.issuer}${SUBJECT_DIVIDER}${userId}`;
}

function profileFromClaims(identity: JwtIdentity): Profile {
  return {
    email: identity.email ? normalizeEmail(identity.email) : undefined,
    name: identity.name,
  };
}

// --- DFTStream CLI tokens ---------------------------------------------------
//
// SECURITY: the `cli|` prefix is a CLAIM, not a credential. It is honoured only
// on tokens issued by the deployment's own issuer (CONVEX_SITE_URL), the only
// key http.ts signs with. auth.config.ts deliberately trusts more than one
// issuer; without this pin any of them could assert `sub: "cli|<victim>|…"`.
// A prefix from the wrong issuer is a forgery attempt, so it throws rather than
// falling through to another provider.
//
// Subjects must carry BOTH parts. The pre-org-scoping 2-part form
// (`cli|<appUserId>`) used to be accepted as an UNSCOPED token that could reach
// every org its human belongs to; http.ts has not minted one since org scoping
// landed and they expire within ACCESS_TTL, so anything still presenting one
// is refused.
const cliProvider: IdentityProvider = {
  kind: IDENTITY_PROVIDER.CLI,
  emailVerified: false,
  claims: (identity) => identity.subject.startsWith(CLI_SUBJECT_PREFIX),
  // CLI principals never own an appUsers row of their own.
  ownsAccountKey: () => false,
  principal(identity, env) {
    if (!env.siteUrl || identity.issuer !== env.siteUrl) {
      throw new Error("CLI subject from an untrusted issuer");
    }
    const parts = identity.subject
      .slice(CLI_SUBJECT_PREFIX.length)
      .split(SUBJECT_DIVIDER);
    const [appUserId, organizationId] = parts;
    if (parts.length !== 2 || !appUserId || !organizationId) {
      throw new Error("malformed CLI token subject");
    }
    return {
      kind: PRINCIPAL_KIND.CLI,
      provider: IDENTITY_PROVIDER.CLI,
      appUserId,
      organizationId,
    };
  },
  // A CLI token acts as an already-provisioned user; nothing to stamp.
  profile: async () => ({}),
};

// --- convex-auth (Password) ---------------------------------------------------
//
// SECURITY: the users-table lookup is honoured ONLY for tokens minted by this
// deployment's own convex-auth issuer — the sole issuer whose subjects embed a
// `users` id. Resolving any other issuer's subject against the table would let
// a foreign token whose subject names a victim's users row graft that victim's
// email onto the caller's appUsers row, and email is exactly what
// organizations.addMember matches on. normalizeId keeps an opaque subject from
// reaching ctx.db.get.
//
// The Password flow performs NO email verification (auth.ts), so its emails
// are self-asserted.
const convexAuthProvider: IdentityProvider = {
  kind: IDENTITY_PROVIDER.CONVEX_AUTH,
  emailVerified: false,
  claims: (identity, env) =>
    env.siteUrl !== undefined && identity.issuer === env.siteUrl,
  ownsAccountKey: (accountKey, env) =>
    env.siteUrl !== undefined &&
    accountKey.startsWith(`${env.siteUrl}${SUBJECT_DIVIDER}`),
  principal: (identity) => ({
    kind: PRINCIPAL_KIND.ACCOUNT,
    provider: IDENTITY_PROVIDER.CONVEX_AUTH,
    accountKey: accountKeyOf(identity),
  }),
  async profile(ctx, identity) {
    // The convex-auth JWT carries no email/name; they live in its own
    // `users` table. A token that does carry them is taken at its word.
    if (identity.email) return profileFromClaims(identity);
    const userId = ctx.db.normalizeId(
      "users",
      identity.subject.split(SUBJECT_DIVIDER)[0] ?? "",
    );
    if (!userId) return {};
    // The row is the caller's own by construction: the subject's userId part
    // IS the users-table id, and only this issuer signs such subjects.
    const authUser = await ctx.db.get(userId);
    if (!authUser) return {};
    return {
      email: authUser.email ? normalizeEmail(authUser.email) : undefined,
      name: authUser.name,
    };
  },
};

// --- Clerk and any other external OIDC issuer --------------------------------
//
// Profile comes straight off the JWT claims. External issuers are assumed to
// verify email (docs/auth.md): an operator who adds a non-verifying issuer to
// auth.config.ts reopens the invite hijack for accounts from that issuer.
function externalProvider(
  kind: IdentityProviderKind,
  issuerOf: (env: IssuerEnv) => string | undefined,
): IdentityProvider {
  const isOwnIssuer = (issuer: string, env: IssuerEnv) => {
    const own = issuerOf(env);
    // No configured issuer = the catch-all: owns whatever is left.
    return own === undefined ? true : issuer === own;
  };
  return {
    kind,
    emailVerified: true,
    claims: (identity, env) => isOwnIssuer(identity.issuer, env),
    ownsAccountKey: (accountKey, env) => {
      const own = issuerOf(env);
      return own === undefined || accountKey.startsWith(`${own}${SUBJECT_DIVIDER}`);
    },
    principal: (identity) => ({
      kind: PRINCIPAL_KIND.ACCOUNT,
      provider: kind,
      accountKey: accountKeyOf(identity),
    }),
    profile: async (_ctx, identity) => profileFromClaims(identity),
  };
}

// Clerk is only a distinct provider when its issuer is configured; with the
// var empty or unset it must never claim anything (the catch-all does).
const NEVER_MATCHES = "\u0000no-issuer";

const clerkProvider = externalProvider(IDENTITY_PROVIDER.CLERK, (env) =>
  env.clerkIssuerDomain ? env.clerkIssuerDomain : NEVER_MATCHES,
);
const externalCatchAll = externalProvider(IDENTITY_PROVIDER.EXTERNAL, () => undefined);

// Order matters: the CLI provider shares the site-URL issuer with convex-auth
// and must see `cli|` subjects first; the catch-all goes last.
const PROVIDERS: readonly IdentityProvider[] = [
  cliProvider,
  convexAuthProvider,
  clerkProvider,
  externalCatchAll,
];

export function providerFor(
  identity: JwtIdentity,
  env: IssuerEnv = runtimeIssuerEnv(),
): IdentityProvider {
  // The catch-all claims everything, so find() always succeeds.
  return PROVIDERS.find((p) => p.claims(identity, env)) ?? externalCatchAll;
}

// The normalized principal for a verified identity. Throws on a forged or
// malformed CLI subject.
export function principalOf(
  identity: JwtIdentity,
  env: IssuerEnv = runtimeIssuerEnv(),
): Principal {
  return providerFor(identity, env).principal(identity, env);
}

export async function profileOf(
  ctx: QueryCtx,
  identity: JwtIdentity,
  env: IssuerEnv = runtimeIssuerEnv(),
): Promise<Profile> {
  return await providerFor(identity, env).profile(ctx, identity, env);
}

// Whether the account behind an appUsers.tokenIdentifier holds a
// provider-verified email. Fails CLOSED: with the deployment's own issuer
// unset we cannot tell a convex-auth key from an external one, so every
// account counts as unverified.
export function accountEmailVerified(
  accountKey: string,
  env: IssuerEnv = runtimeIssuerEnv(),
): boolean {
  if (!env.siteUrl) return false;
  const owner = PROVIDERS.find((p) => p.ownsAccountKey(accountKey, env));
  return owner?.emailVerified ?? false;
}
