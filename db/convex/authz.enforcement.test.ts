/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import {
  AUTHZ_POLICY,
  authEnabled,
  authzPolicy,
  normalizeEmail,
} from "./authz";

const modules = import.meta.glob("./**/*.ts");

// This suite covers the enforcement-layer hardening:
//   1. strict, fail-closed parsing of DFTSTREAM_AUTH_REQUIRED (+ the
//      authRequired flag on the public meta.version handshake);
//   2. the pending-invite flow that closes the pre-registration email hijack
//      in organizations.addMember;
//   3. email normalization on every write path + the one-shot legacy fixer;
//   4. resolveProfile refusing to backfill email/name from a users-table row
//      that a foreign issuer's subject merely happens to name.
// Behavioural role/tenancy coverage lives in authz.test.ts.

// Distinct mocked identities. Issuer "test" stands in for an external,
// email-verifying provider (Clerk-shaped); DEPLOYMENT_ISSUER is the
// deployment's own convex-auth, whose Password flow never verifies email.
const alice = { subject: "alice", issuer: "test", email: "alice@lab.edu" };
const bob = { subject: "bob", issuer: "test", email: "bob@lab.edu" };

// Must equal CONVEX_SITE_URL, which vitest.config.ts pins for the suite.
const DEPLOYMENT_ISSUER = "https://test.convex.site";

function setup() {
  return convexTest(schema, modules);
}

type Harness = ReturnType<typeof setup>;

async function appUserByToken(t: Harness, tokenIdentifier: string) {
  return await t.run(async (ctx) => {
    return await ctx.db
      .query("appUsers")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", tokenIdentifier))
      .unique();
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// =============================================================================
// 1. DFTSTREAM_AUTH_REQUIRED parsing
// =============================================================================

describe("DFTSTREAM_AUTH_REQUIRED strict parsing", () => {
  test("the suite's pinned '1' enables enforcement", () => {
    expect(authEnabled()).toBe(true);
  });

  test("'true' enables enforcement", () => {
    vi.stubEnv("DFTSTREAM_AUTH_REQUIRED", "true");
    expect(authEnabled()).toBe(true);
  });

  test("unset / empty / '0' / 'false' mean local single-user mode", () => {
    for (const value of [undefined, "", "0", "false"]) {
      vi.stubEnv("DFTSTREAM_AUTH_REQUIRED", value);
      expect(authEnabled(), `value=${JSON.stringify(value)}`).toBe(false);
    }
  });

  test("any other value throws instead of silently disabling auth", () => {
    for (const value of ["TRUE", "True", "yes", "on", "2", " 1", "1 ", "enabled"]) {
      vi.stubEnv("DFTSTREAM_AUTH_REQUIRED", value);
      expect(() => authEnabled(), `value=${JSON.stringify(value)}`).toThrow(
        /DFTSTREAM_AUTH_REQUIRED/,
      );
    }
  });

  test("a malformed flag fails CLOSED at the first gated call", async () => {
    const t = setup();
    const asAlice = t.withIdentity(alice);
    const { organizationId } = await asAlice.mutation(api.organizations.create, {
      name: "Lab",
    });
    // The historical bug: "TRUE" parsed as auth-off and every gate opened.
    vi.stubEnv("DFTSTREAM_AUTH_REQUIRED", "TRUE");
    await expect(
      t.query(api.experiments.list, { organizationId }),
    ).rejects.toThrow(/DFTSTREAM_AUTH_REQUIRED/);
    await expect(
      asAlice.query(api.experiments.list, { organizationId }),
    ).rejects.toThrow(/DFTSTREAM_AUTH_REQUIRED/);
  });

  test("local mode (unset) still works with nothing configured", async () => {
    vi.stubEnv("DFTSTREAM_AUTH_REQUIRED", undefined);
    const t = setup();
    // No identity at all — the single-user install has no auth provider.
    const expId = await t.mutation(api.experiments.ensure, { name: "local-exp" });
    expect(expId).toBeDefined();
    const listed = await t.query(api.experiments.list, {});
    expect(listed.map((e) => e._id)).toEqual([expId]);
  });

  test("the flag selects the authz policy once: local vs orgs", () => {
    expect(authzPolicy().kind).toBe(AUTHZ_POLICY.ORGS);
    vi.stubEnv("DFTSTREAM_AUTH_REQUIRED", "0");
    expect(authzPolicy().kind).toBe(AUTHZ_POLICY.LOCAL);
    vi.stubEnv("DFTSTREAM_AUTH_REQUIRED", "on");
    expect(() => authzPolicy()).toThrow(/DFTSTREAM_AUTH_REQUIRED/);
  });

  test("local policy: every policy-routed gate is open to an anonymous caller", async () => {
    vi.stubEnv("DFTSTREAM_AUTH_REQUIRED", undefined);
    const t = setup();
    const experimentId = await t.mutation(api.experiments.ensure, { name: "local" });
    const runId = await t.mutation(api.runs.create, { experimentId });
    const batchId = await t.mutation(api.experiments.createBatch, {
      experimentId,
      name: "b",
    });
    // gateRunModify, gateExperimentRowModify, gateAnyMembership.
    await t.mutation(api.runs.rename, { runId, name: "renamed" });
    await t.mutation(api.experiments.renameBatch, { batchId, name: "b2" });
    await t.mutation(api.experiments.removeBatch, { batchId });
    expect(await t.mutation(api.artifacts.generateUploadUrl, {})).toEqual(
      expect.any(String),
    );
    await t.mutation(api.experiments.removeRunNow, { runId });
    await t.mutation(api.experiments.remove, { experimentId });
  });

  test("orgs policy: the same gates refuse an anonymous caller", async () => {
    const t = setup();
    const asAlice = t.withIdentity(alice);
    const { organizationId } = await asAlice.mutation(api.organizations.create, {
      name: "Lab",
    });
    const experimentId = await asAlice.mutation(api.experiments.ensure, {
      name: "e",
      organizationId,
    });
    const runId = await asAlice.mutation(api.runs.create, { experimentId });
    await expect(t.mutation(api.runs.rename, { runId, name: "x" })).rejects.toThrow(
      /not authenticated/,
    );
    await expect(t.mutation(api.artifacts.generateUploadUrl, {})).rejects.toThrow(
      /not authenticated/,
    );
    await expect(t.mutation(api.experiments.remove, { experimentId })).rejects.toThrow(
      /not authenticated/,
    );
  });

  test("meta.version exposes the effective authRequired flag", async () => {
    const t = setup();
    expect((await t.query(api.meta.version, {})).authRequired).toBe(true);

    vi.stubEnv("DFTSTREAM_AUTH_REQUIRED", "0");
    expect((await t.query(api.meta.version, {})).authRequired).toBe(false);

    // Misconfiguration is loud even on the public handshake surface.
    vi.stubEnv("DFTSTREAM_AUTH_REQUIRED", "yes");
    await expect(t.query(api.meta.version, {})).rejects.toThrow(
      /DFTSTREAM_AUTH_REQUIRED/,
    );
  });
});

// =============================================================================
// 2. invite flow — pre-registration hijack
// =============================================================================

describe("addMember pending invites and explicit confirmation", () => {
  test("inviting an unknown email records a pending invite and grants nothing", async () => {
    const t = setup();
    const asAlice = t.withIdentity(alice);
    const { organizationId } = await asAlice.mutation(api.organizations.create, {
      name: "Lab",
    });

    const res = await asAlice.mutation(api.organizations.addMember, {
      organizationId,
      email: "Ghost@Lab.EDU",
      role: "member",
    });
    expect(res.status).toBe("invited");

    const invites = await asAlice.query(api.organizations.listInvites, {
      organizationId,
    });
    expect(invites).toHaveLength(1);
    expect(invites[0]).toMatchObject({ email: "ghost@lab.edu", role: "member" });

    // Nothing was granted: the roster is still just Alice.
    const members = await asAlice.query(api.organizations.members, {
      organizationId,
    });
    expect(members).toHaveLength(1);
  });

  test("signing up with an invited email does NOT redeem the invite", async () => {
    const t = setup();
    const asAlice = t.withIdentity(alice);
    const { organizationId } = await asAlice.mutation(api.organizations.create, {
      name: "Lab",
    });
    await asAlice.mutation(api.organizations.addMember, {
      organizationId,
      email: "ghost@lab.edu",
      role: "member",
    });

    // Mallory registers the invited address FIRST, through the deployment's
    // own Password flow — which never verifies email ownership.
    const asMallory = t.withIdentity({
      subject: "mallory|s1",
      issuer: DEPLOYMENT_ISSUER,
      email: "ghost@lab.edu",
    });
    await asMallory.mutation(api.users.ensureSelf, {});

    // Sign-up alone granted nothing.
    expect(
      await asAlice.query(api.organizations.members, { organizationId }),
    ).toHaveLength(1);
    await expect(
      asMallory.query(api.experiments.list, { organizationId }),
    ).rejects.toThrow(/not a member/);

    // The admin's follow-up call still does not silently grant: it surfaces
    // the account so the admin can see it was created AFTER the invite.
    const res = await asAlice.mutation(api.organizations.addMember, {
      organizationId,
      email: "ghost@lab.edu",
      role: "member",
    });
    if (res.status !== "needs-confirmation") {
      throw new Error(`expected needs-confirmation, got ${res.status}`);
    }
    expect(res.candidate.email).toBe("ghost@lab.edu");
    expect(res.candidate.invitePendingSince).not.toBeNull();
    expect(typeof res.candidate.accountCreatedAt).toBe("number");
    expect(
      await asAlice.query(api.organizations.members, { organizationId }),
    ).toHaveLength(1);

    // Only the explicit, id-bound confirmation grants — and it consumes the
    // pending invite.
    const confirmed = await asAlice.mutation(api.organizations.addMember, {
      organizationId,
      email: "ghost@lab.edu",
      role: "member",
      confirmUserId: res.candidate.userId,
    });
    expect(confirmed.status).toBe("added");
    expect(
      await asAlice.query(api.organizations.members, { organizationId }),
    ).toHaveLength(2);
    expect(
      await asAlice.query(api.organizations.listInvites, { organizationId }),
    ).toEqual([]);
    expect(
      await asMallory.query(api.experiments.list, { organizationId }),
    ).toEqual([]);
  });

  test("re-inviting an unverified account that is already a member says so, not needs-confirmation", async () => {
    const t = setup();
    const asAlice = t.withIdentity(alice);
    const { organizationId } = await asAlice.mutation(api.organizations.create, {
      name: "Lab",
    });
    const asDan = t.withIdentity({
      subject: "dan|session1",
      issuer: DEPLOYMENT_ISSUER,
      email: "dan@lab.edu",
    });
    const danId = await asDan.mutation(api.users.ensureSelf, {});
    await asAlice.mutation(api.organizations.addMember, {
      organizationId,
      email: "dan@lab.edu",
      role: "member",
      confirmUserId: danId,
    });
    // Before: this returned needs-confirmation, sending the admin off to
    // verify the person out-of-band only for the confirm to fail.
    await expect(
      asAlice.mutation(api.organizations.addMember, {
        organizationId,
        email: "dan@lab.edu",
        role: "admin",
      }),
    ).rejects.toThrow(/already a member/);
  });

  test("a pre-registered unverified account never gets membership without confirmation", async () => {
    const t = setup();
    // Mallory squats victim@lab.edu BEFORE any invite exists.
    const asMallory = t.withIdentity({
      subject: "mallory|s1",
      issuer: DEPLOYMENT_ISSUER,
      email: "victim@lab.edu",
    });
    await asMallory.mutation(api.users.ensureSelf, {});

    const asAlice = t.withIdentity(alice);
    const { organizationId } = await asAlice.mutation(api.organizations.create, {
      name: "Lab",
    });

    // The old code silently inserted the membership here.
    const res = await asAlice.mutation(api.organizations.addMember, {
      organizationId,
      email: "victim@lab.edu",
      role: "admin",
    });
    if (res.status !== "needs-confirmation") {
      throw new Error(`expected needs-confirmation, got ${res.status}`);
    }
    // The warning carries what the admin needs to verify out-of-band.
    expect(typeof res.candidate.accountCreatedAt).toBe("number");
    expect(typeof res.candidate.lastSeenAt).toBe("number");
    expect(res.candidate.invitePendingSince).toBeNull();
    expect(
      await asAlice.query(api.organizations.members, { organizationId }),
    ).toHaveLength(1);
    await expect(
      asMallory.query(api.experiments.list, { organizationId }),
    ).rejects.toThrow(/not a member/);

    // Confirmation is bound to the reviewed account: confirming an id whose
    // email does not match the invite throws instead of granting.
    const aliceId = await asAlice.mutation(api.users.ensureSelf, {});
    await expect(
      asAlice.mutation(api.organizations.addMember, {
        organizationId,
        email: "victim@lab.edu",
        role: "admin",
        confirmUserId: aliceId,
      }),
    ).rejects.toThrow(/no longer matches/);

    // Explicit confirmation of the right account is the one path that grants.
    const confirmed = await asAlice.mutation(api.organizations.addMember, {
      organizationId,
      email: "victim@lab.edu",
      role: "admin",
      confirmUserId: res.candidate.userId,
    });
    expect(confirmed.status).toBe("added");
    expect(
      await asAlice.query(api.organizations.members, { organizationId }),
    ).toHaveLength(2);
  });

  test("an account from a verifying issuer still joins in one call", async () => {
    const t = setup();
    const asAlice = t.withIdentity(alice);
    const asBob = t.withIdentity(bob);
    const { organizationId } = await asAlice.mutation(api.organizations.create, {
      name: "Lab",
    });
    await asBob.mutation(api.users.ensureSelf, {});

    // Bob's issuer ("test") is not the deployment's own Password flow, so his
    // email is provider-verified and the single-call flow is preserved.
    const res = await asAlice.mutation(api.organizations.addMember, {
      organizationId,
      email: "bob@lab.edu",
      role: "member",
    });
    expect(res.status).toBe("added");
    expect(await asBob.query(api.experiments.list, { organizationId })).toEqual([]);
  });

  test("pending invites are admin-visible and revocable", async () => {
    const t = setup();
    const asAlice = t.withIdentity(alice);
    const asBob = t.withIdentity(bob);
    const { organizationId } = await asAlice.mutation(api.organizations.create, {
      name: "Lab",
    });
    const res = await asAlice.mutation(api.organizations.addMember, {
      organizationId,
      email: "ghost@lab.edu",
      role: "viewer",
    });
    if (res.status !== "invited") {
      throw new Error(`expected invited, got ${res.status}`);
    }

    // A viewer (non-admin) cannot see or revoke the recruiting list.
    await asBob.mutation(api.users.ensureSelf, {});
    await asAlice.mutation(api.organizations.addMember, {
      organizationId,
      email: "bob@lab.edu",
      role: "viewer",
    });
    await expect(
      asBob.query(api.organizations.listInvites, { organizationId }),
    ).rejects.toThrow(/insufficient permission/);
    await expect(
      asBob.mutation(api.organizations.revokeInvite, { inviteId: res.inviteId }),
    ).rejects.toThrow(/insufficient permission/);

    await asAlice.mutation(api.organizations.revokeInvite, {
      inviteId: res.inviteId,
    });
    expect(
      await asAlice.query(api.organizations.listInvites, { organizationId }),
    ).toEqual([]);
  });
});

// =============================================================================
// 3. email normalization
// =============================================================================

describe("email normalization", () => {
  test("normalizeEmail trims and lowercases", () => {
    expect(normalizeEmail("  Dana.Q@Lab.EDU ")).toBe("dana.q@lab.edu");
  });

  test("identity emails are stored normalized and matched case-insensitively", async () => {
    const t = setup();
    const asDana = t.withIdentity({
      subject: "dana",
      issuer: "test",
      email: "Dana.Q@Lab.EDU",
    });
    await asDana.mutation(api.users.ensureSelf, {});
    const row = await appUserByToken(t, "test|dana");
    expect(row?.email).toBe("dana.q@lab.edu");

    // A differently-cased, padded invite still finds the account.
    const asAlice = t.withIdentity(alice);
    const { organizationId } = await asAlice.mutation(api.organizations.create, {
      name: "Lab",
    });
    const res = await asAlice.mutation(api.organizations.addMember, {
      organizationId,
      email: " DANA.Q@lab.edu ",
      role: "member",
    });
    expect(res.status).toBe("added");
  });

  test("normalizeEmailsNow canonicalizes legacy mixed-case rows", async () => {
    const t = setup();
    const legacyId = await t.run(async (ctx) => {
      return await ctx.db.insert("appUsers", {
        tokenIdentifier: "legacy-issuer|legacy-user",
        email: "Legacy.User@Lab.EDU",
        createdAt: Date.now(),
      });
    });
    await t.mutation(internal.organizations.normalizeEmailsNow, {});
    const row = await t.run(async (ctx) => await ctx.db.get(legacyId));
    expect(row?.email).toBe("legacy.user@lab.edu");
  });
});

// =============================================================================
// 4. resolveProfile hardening
// =============================================================================

describe("resolveProfile users-table backfill", () => {
  test("a foreign issuer's subject cannot graft a users-table email onto its row", async () => {
    const t = setup();
    // A convex-auth users row belonging to somebody else.
    const usersId = await t.run(async (ctx) => {
      return await ctx.db.insert("users", { email: "victim2@lab.edu" });
    });
    // Eve's token comes from a different trusted issuer and carries no email,
    // but its subject names the victim's users row. Before the issuer pin this
    // stamped victim2@lab.edu onto Eve's appUsers row — the exact field
    // addMember matches invites on.
    const asEve = t.withIdentity({
      subject: `${usersId}|sess1`,
      issuer: "https://evil.example",
    });
    await asEve.mutation(api.users.ensureSelf, {});
    const row = await appUserByToken(t, `https://evil.example|${usersId}`);
    expect(row).not.toBeNull();
    expect(row?.email).toBeUndefined();
  });

  test("the deployment's own issuer backfills, normalized, from its users row", async () => {
    const t = setup();
    const usersId = await t.run(async (ctx) => {
      return await ctx.db.insert("users", { email: "Mixed@Case.EDU" });
    });
    const asSelf = t.withIdentity({
      subject: `${usersId}|sess1`,
      issuer: DEPLOYMENT_ISSUER,
    });
    await asSelf.mutation(api.users.ensureSelf, {});
    const row = await appUserByToken(t, `${DEPLOYMENT_ISSUER}|${usersId}`);
    expect(row?.email).toBe("mixed@case.edu");
  });
});
