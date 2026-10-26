import { describe, expect, test } from "vitest";
import {
  CONVEX_APPLICATION_ID,
  IDENTITY_PROVIDER,
  authConfigProviders,
  type IssuerEnv,
} from "./authIssuers";
import {
  PRINCIPAL_KIND,
  accountEmailVerified,
  cliSubject,
  principalOf,
  providerFor,
} from "./identityProviders";

const SITE = "https://dep.convex.site";
const CLERK = "https://acme.clerk.accounts.dev";
const bothEnv: IssuerEnv = { siteUrl: SITE, clerkIssuerDomain: CLERK };
const siteOnly: IssuerEnv = { siteUrl: SITE, clerkIssuerDomain: undefined };

describe("auth.config provider registry", () => {
  test("no issuers configured → trusts nothing (no-auth deployment)", () => {
    expect(
      authConfigProviders({ siteUrl: undefined, clerkIssuerDomain: undefined }),
    ).toEqual([]);
  });

  test("empty CLERK_JWT_ISSUER_DOMAIN (the seeded push value) adds no Clerk entry", () => {
    expect(authConfigProviders({ siteUrl: SITE, clerkIssuerDomain: "" })).toEqual([
      { domain: SITE, applicationID: CONVEX_APPLICATION_ID },
    ]);
  });

  test("site URL first, then Clerk, same order as before the registry", () => {
    expect(authConfigProviders(bothEnv)).toEqual([
      { domain: SITE, applicationID: "convex" },
      { domain: CLERK, applicationID: "convex" },
    ]);
  });
});

describe("identity providers → principal", () => {
  test("`cli|` subject from the site issuer is a CLI principal", () => {
    const p = principalOf(
      { issuer: SITE, subject: cliSubject("user123", "org456") },
      bothEnv,
    );
    expect(p).toEqual({
      kind: PRINCIPAL_KIND.CLI,
      provider: IDENTITY_PROVIDER.CLI,
      appUserId: "user123",
      organizationId: "org456",
    });
  });

  test("`cli|` subject from any other issuer is a forgery", () => {
    expect(() =>
      principalOf({ issuer: CLERK, subject: cliSubject("u", "o") }, bothEnv),
    ).toThrow(/untrusted issuer/);
  });

  test("legacy unscoped 2-part CLI subject is refused, not treated as all-orgs", () => {
    expect(() =>
      principalOf({ issuer: SITE, subject: "cli|user123" }, bothEnv),
    ).toThrow(/malformed CLI token subject/);
    expect(() =>
      principalOf({ issuer: SITE, subject: "cli|user123|" }, bothEnv),
    ).toThrow(/malformed CLI token subject/);
    expect(() =>
      principalOf({ issuer: SITE, subject: "cli|a|b|c" }, bothEnv),
    ).toThrow(/malformed CLI token subject/);
  });

  test("convex-auth subject drops the per-login session id", () => {
    const p = principalOf({ issuer: SITE, subject: "userA|session1" }, bothEnv);
    expect(p).toEqual({
      kind: PRINCIPAL_KIND.ACCOUNT,
      provider: IDENTITY_PROVIDER.CONVEX_AUTH,
      accountKey: `${SITE}|userA`,
    });
    // A later login (new session) maps to the same account.
    expect(principalOf({ issuer: SITE, subject: "userA|session2" }, bothEnv)).toEqual(p);
  });

  test("Clerk issuer is the Clerk provider; unknown issuers fall to the catch-all", () => {
    expect(providerFor({ issuer: CLERK, subject: "user_1" }, bothEnv).kind).toBe(
      IDENTITY_PROVIDER.CLERK,
    );
    expect(providerFor({ issuer: "https://other.idp", subject: "x" }, bothEnv).kind).toBe(
      IDENTITY_PROVIDER.EXTERNAL,
    );
    // Clerk unconfigured: its issuer is just another external one.
    expect(providerFor({ issuer: CLERK, subject: "user_1" }, siteOnly).kind).toBe(
      IDENTITY_PROVIDER.EXTERNAL,
    );
    expect(principalOf({ issuer: CLERK, subject: "user_1" }, bothEnv)).toMatchObject({
      accountKey: `${CLERK}|user_1`,
    });
  });
});

describe("accountEmailVerified", () => {
  test("convex-auth (self-asserted) accounts are unverified", () => {
    expect(accountEmailVerified(`${SITE}|userA`, bothEnv)).toBe(false);
  });

  test("Clerk and other external accounts are assumed verified", () => {
    expect(accountEmailVerified(`${CLERK}|user_1`, bothEnv)).toBe(true);
    expect(accountEmailVerified("https://other.idp|x", bothEnv)).toBe(true);
  });

  test("fails closed when the deployment issuer is unknown", () => {
    expect(
      accountEmailVerified(`${CLERK}|user_1`, {
        siteUrl: undefined,
        clerkIssuerDomain: CLERK,
      }),
    ).toBe(false);
  });
});
