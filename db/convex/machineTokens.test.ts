/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeAll, describe, expect, test } from "vitest";
import { decodeJwt, exportPKCS8, generateKeyPair } from "jose";
import { api } from "./_generated/api";
import schema from "./schema";
import { sha256HexSync } from "./lib/sha256";

// Machine tokens (P0-2 non-interactive auth): minting is a browser-only admin
// mutation; the secret is stored digest-only; POST /cli/token/exchange trades
// it for the same short-lived org-scoped `cli|` access token the browser-link
// flow mints; revocation and creator-membership loss bite at the next
// exchange; the exchange surface is throttled per token.

const modules = import.meta.glob("./**/*.ts");

const alice = { subject: "alice", issuer: "test", email: "alice@lab.edu" };
const bob = { subject: "bob", issuer: "test", email: "bob@lab.edu" };
const carol = { subject: "carol", issuer: "test", email: "carol@lab.edu" };

// Must match the issuer authz.parseCliSubject trusts (pinned CONVEX_SITE_URL
// in vitest.config.ts).
const CLI_ISSUER = "https://test.convex.site";

// Mirrors machineTokens.MIN_EXCHANGE_INTERVAL_MS; literal so a silent change
// to the server constant fails a test instead of going unnoticed.
const MIN_EXCHANGE_INTERVAL_MS = 250;

beforeAll(async () => {
  // /cli/token/exchange mints real JWTs; give http.ts a signing key.
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(privateKey);
});

function setup() {
  return convexTest(schema, modules);
}

type Harness = ReturnType<typeof setup>;

async function subtleSha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// An org owned by alice, with bob (viewer) and carol (admin) as members.
async function orgFixture() {
  const t = setup();
  const asAlice = t.withIdentity(alice);
  const asBob = t.withIdentity(bob);
  const asCarol = t.withIdentity(carol);
  const { organizationId } = await asAlice.mutation(api.organizations.create, {
    name: "Lab",
  });
  await asBob.mutation(api.users.ensureSelf, {});
  await asCarol.mutation(api.users.ensureSelf, {});
  await asAlice.mutation(api.organizations.addMember, {
    organizationId,
    email: "bob@lab.edu",
    role: "viewer",
  });
  await asAlice.mutation(api.organizations.addMember, {
    organizationId,
    email: "carol@lab.edu",
    role: "admin",
  });
  return { t, asAlice, asBob, asCarol, organizationId };
}

async function tokenRow(t: Harness, digest: string) {
  return await t.run(async (ctx) => {
    return await ctx.db
      .query("machineTokens")
      .withIndex("by_digest", (q) => q.eq("digest", digest))
      .unique();
  });
}

async function exchange(t: Harness, token: string): Promise<Response> {
  return await t.fetch("/cli/token/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

// Rewind the per-token throttle window so back-to-back test exchanges are not
// refused as slow_down.
async function agePastThrottle(t: Harness, digest: string) {
  await t.run(async (ctx) => {
    const row = await ctx.db
      .query("machineTokens")
      .withIndex("by_digest", (q) => q.eq("digest", digest))
      .unique();
    await ctx.db.patch(row!._id, {
      lastUsedAt: Date.now() - MIN_EXCHANGE_INTERVAL_MS - 50,
    });
  });
}

describe("sha256HexSync matches the crypto.subtle digest http.ts uses", () => {
  // The create mutation hashes with the sync implementation; the exchange
  // route hashes with crypto.subtle. They MUST agree or every exchange 401s.
  test("FIPS 180-4 vectors and a token-shaped string", async () => {
    // Known-answer vectors pin the implementation, not just the equivalence.
    expect(sha256HexSync("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256HexSync("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    for (const value of [
      "abc",
      "ost_dGhpcyBpcyBhIHRva2VuIHNoYXBlZCBzdHJpbmc44444",
      "a".repeat(200), // multi-block message
      "ünïcode-παράδειγμα", // multi-byte UTF-8
    ]) {
      expect(sha256HexSync(value)).toBe(await subtleSha256Hex(value));
    }
  });
});

describe("minting", () => {
  test("admin creates a token; only the digest is stored", async () => {
    const { t, asCarol, organizationId } = await orgFixture();
    const created = await asCarol.mutation(api.machineTokens.create, {
      organizationId,
      name: "  cluster-A batch  ",
    });
    // ost_ prefix + base64url of 32 bytes (43 chars, no padding).
    expect(created.token).toMatch(/^ost_[A-Za-z0-9_-]{43}$/);
    expect(created.name).toBe("cluster-A batch"); // trimmed

    const row = await tokenRow(t, sha256HexSync(created.token));
    expect(row).not.toBeNull();
    expect(row!.organizationId).toBe(organizationId);
    // Nothing anywhere in the row equals the plaintext secret.
    expect(JSON.stringify(row)).not.toContain(created.token);
  });

  test("viewer, non-member and empty names are refused", async () => {
    const { t, asAlice, asBob, organizationId } = await orgFixture();
    await expect(
      asBob.mutation(api.machineTokens.create, {
        organizationId,
        name: "viewer-token",
      }),
    ).rejects.toThrow(/insufficient permission/);
    // An authenticated stranger with no membership at all.
    const asStranger = t.withIdentity({
      subject: "dave",
      issuer: "test",
      email: "dave@lab.edu",
    });
    await expect(
      asStranger.mutation(api.machineTokens.create, {
        organizationId,
        name: "stranger-token",
      }),
    ).rejects.toThrow(/not a member/);
    await expect(
      asAlice.mutation(api.machineTokens.create, {
        organizationId,
        name: "   ",
      }),
    ).rejects.toThrow(/name must not be empty/);
  });

  test("a CLI/machine access token cannot mint or revoke tokens (browser-only)", async () => {
    const { t, asAlice, organizationId } = await orgFixture();
    const created = await asAlice.mutation(api.machineTokens.create, {
      organizationId,
      name: "seed",
    });
    const row = await tokenRow(t, sha256HexSync(created.token));
    // The exact caller shape /cli/token/exchange mints: the creator's own
    // appUserId, org-scoped — i.e. the strongest CLI credential possible.
    const asCli = t.withIdentity({
      subject: `cli|${row!.createdByUserId}|${organizationId}`,
      issuer: CLI_ISSUER,
    });
    await expect(
      asCli.mutation(api.machineTokens.create, {
        organizationId,
        name: "laundered",
      }),
    ).rejects.toThrow(/browser session/);
    await expect(
      asCli.mutation(api.machineTokens.revoke, { tokenId: created.tokenId }),
    ).rejects.toThrow(/browser session/);
  });
});

describe("listing", () => {
  test("admins see metadata but never the digest; viewers see nothing", async () => {
    const { asAlice, asBob, asCarol, organizationId } = await orgFixture();
    await asCarol.mutation(api.machineTokens.create, {
      organizationId,
      name: "tok-1",
    });
    const listed = await asAlice.query(api.machineTokens.list, {
      organizationId,
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: "tok-1", revokedAt: null });
    expect(Object.keys(listed[0]!)).not.toContain("digest");
    expect(JSON.stringify(listed)).not.toContain("ost_");

    await expect(
      asBob.query(api.machineTokens.list, { organizationId }),
    ).rejects.toThrow(/insufficient permission/);
  });
});

describe("POST /cli/token/exchange", () => {
  test("happy path: token → org-scoped cli| access token, lastUsedAt stamped", async () => {
    const { t, asCarol, organizationId } = await orgFixture();
    const created = await asCarol.mutation(api.machineTokens.create, {
      organizationId,
      name: "batch",
    });

    const res = await exchange(t, created.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accessToken: string;
      organizationId: string;
    };
    expect(body.organizationId).toBe(organizationId);

    // The JWT carries the same subject scheme the browser-link poll mints:
    // cli|<creator appUsersId>|<orgId>, issued by the pinned CLI issuer.
    const row = await tokenRow(t, sha256HexSync(created.token));
    const claims = decodeJwt(body.accessToken);
    expect(claims.sub).toBe(`cli|${row!.createdByUserId}|${organizationId}`);
    expect(claims.iss).toBe(CLI_ISSUER);
    expect(row!.lastUsedAt).toBeDefined();

    // And that identity actually works — and is scoped: acting in the bound
    // org succeeds, minting credentials is still refused (asCli tested above).
    const asMachine = t.withIdentity({
      subject: claims.sub!,
      issuer: CLI_ISSUER,
    });
    await asMachine.mutation(api.experiments.ensure, {
      name: "from-batch",
      organizationId,
    });
  });

  test("unknown token → 401 with no session material", async () => {
    const { t } = await orgFixture();
    const res = await exchange(t, "ost_never-minted");
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain("accessToken");
  });

  test("missing token → 400", async () => {
    const { t } = await orgFixture();
    const res = await t.fetch("/cli/token/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("malformed or non-string bodies → 400, never a 500", async () => {
    const { t } = await orgFixture();
    const post = (body: string) =>
      t.fetch("/cli/token/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
    // Not JSON at all: used to throw out of req.json() as an opaque 500.
    expect((await post("{not json")).status).toBe(400);
    // JSON, but the field is not a string: used to reach sha256 via a cast.
    expect((await post(JSON.stringify({ token: 42 }))).status).toBe(400);
    expect((await post(JSON.stringify({ token: ["ost_x"] }))).status).toBe(400);
    expect((await post(JSON.stringify(null))).status).toBe(400);
    expect((await post(JSON.stringify({ token: "" }))).status).toBe(400);
  });

  test("revoked token → 410 and no session; revoke is idempotent", async () => {
    const { t, asAlice, organizationId } = await orgFixture();
    const created = await asAlice.mutation(api.machineTokens.create, {
      organizationId,
      name: "doomed",
    });
    await asAlice.mutation(api.machineTokens.revoke, {
      tokenId: created.tokenId,
    });
    await asAlice.mutation(api.machineTokens.revoke, {
      tokenId: created.tokenId,
    }); // second revoke is a no-op, not an error

    const res = await exchange(t, created.token);
    expect(res.status).toBe(410);
    expect(JSON.stringify(await res.json())).not.toContain("accessToken");
    // Revocation survives: still 410 on retry, never a resurrection.
    expect((await exchange(t, created.token)).status).toBe(410);
  });

  test("viewer cannot revoke another admin's token", async () => {
    const { asAlice, asBob, organizationId } = await orgFixture();
    const created = await asAlice.mutation(api.machineTokens.create, {
      organizationId,
      name: "prod",
    });
    await expect(
      asBob.mutation(api.machineTokens.revoke, { tokenId: created.tokenId }),
    ).rejects.toThrow(/insufficient permission/);
  });

  test("exchange under the per-token floor gets slow_down without losing the slot", async () => {
    const { t, asAlice, organizationId } = await orgFixture();
    const created = await asAlice.mutation(api.machineTokens.create, {
      organizationId,
      name: "hot",
    });
    expect((await exchange(t, created.token)).status).toBe(200);
    // Immediate re-exchange: throttled.
    const tooSoon = await exchange(t, created.token);
    expect(tooSoon.status).toBe(429);
    expect(((await tooSoon.json()) as { error: string }).error).toBe(
      "slow_down",
    );
    // A compliant retry after the interval is served — the refused attempt
    // must not have advanced the window.
    await agePastThrottle(t, sha256HexSync(created.token));
    expect((await exchange(t, created.token)).status).toBe(200);
  });

  test("deleting the org deletes its machine tokens", async () => {
    const { t, asAlice, organizationId } = await orgFixture();
    const created = await asAlice.mutation(api.machineTokens.create, {
      organizationId,
      name: "ci",
    });
    await asAlice.mutation(api.organizations.remove, { organizationId });
    // Before: the rows outlived the org with nothing left to list or revoke
    // them from.
    expect(await tokenRow(t, sha256HexSync(created.token))).toBeNull();
    expect((await exchange(t, created.token)).status).toBe(401);
  });

  test("the token dies when its creator leaves the org (T4 for machines)", async () => {
    const { t, asAlice, asCarol, organizationId } = await orgFixture();
    const created = await asCarol.mutation(api.machineTokens.create, {
      organizationId,
      name: "carols",
    });
    expect((await exchange(t, created.token)).status).toBe(200);

    // Offboard carol without her cooperation.
    const carolMembership = await t.run(async (ctx) => {
      const user = await ctx.db
        .query("appUsers")
        .withIndex("by_email", (q) => q.eq("email", "carol@lab.edu"))
        .unique();
      return await ctx.db
        .query("memberships")
        .withIndex("by_user_org", (q) =>
          q.eq("appUserId", user!._id).eq("organizationId", organizationId),
        )
        .unique();
    });
    await asAlice.mutation(api.organizations.removeMember, {
      membershipId: carolMembership!._id,
    });

    await agePastThrottle(t, sha256HexSync(created.token));
    // Removal revokes the tokens she minted outright (410, like an admin
    // revoke), rather than leaving them merely dormant.
    expect((await exchange(t, created.token)).status).toBe(410);

    // Re-adding her must NOT revive them: the live-membership check alone
    // used to let a returning member's old (possibly leaked) tokens work
    // again.
    await asAlice.mutation(api.organizations.addMember, {
      organizationId,
      email: "carol@lab.edu",
      role: "admin",
    });
    await agePastThrottle(t, sha256HexSync(created.token));
    expect((await exchange(t, created.token)).status).toBe(410);
  });
});
