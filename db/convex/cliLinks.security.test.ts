/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { exportPKCS8, generateKeyPair } from "jose";
import { api, internal } from "./_generated/api";
import schema, { CLI_LINK_STATUS } from "./schema";
import { normalizeUserCode } from "./cliLinks";

// Security-focused tests for the CLI browser-link (device authorization) flow:
//   - the user code that travels in the browser URL can never yield tokens;
//   - refresh tokens are stored only as sha256 digests;
//   - refresh tokens rotate, and replaying a rotated-out token revokes the
//     whole session (stolen-credential detection);
//   - the unauthenticated HTTP surface is throttled (slow_down, poll cap,
//     pending-handshake cap) and swept;
//   - cliLinks.revoke is browser-only like every other credential mutation.
//
// The lifecycle basics (expiry, single-use, membership loss, admin revoke)
// live in authz.test.ts.

const modules = import.meta.glob("./**/*.ts");

const alice = { subject: "alice", issuer: "test", email: "alice@lab.edu" };

// Must match the issuer authz.parseCliSubject trusts (pinned CONVEX_SITE_URL
// in vitest.config.ts).
const CLI_ISSUER = "https://test.convex.site";

// Mirrors the caps in cliLinks.ts. Kept literal here so a silent change to the
// server constants fails a test instead of going unnoticed.
const MIN_POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 300;
const MAX_PENDING_LINKS = 100;
const ROTATION_GRACE_MS = 60 * 1000;

beforeAll(async () => {
  // /cli/link/poll and /refresh mint real JWTs; give http.ts a signing key.
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(privateKey);
});

function setup() {
  return convexTest(schema, modules);
}

type Harness = ReturnType<typeof setup>;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

type StartBody = {
  deviceCode: string;
  userCode: string;
  verifyPath: string;
  interval: number;
};

type ApprovedBody = {
  status: string;
  accessToken: string;
  refreshToken: string;
  organizationId: string;
  organizationName: string | null;
  organizationSlug: string | null;
};

async function postJson(
  t: Harness,
  path: string,
  body: unknown,
): Promise<Response> {
  return await t.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function httpStart(t: Harness): Promise<StartBody> {
  const res = await postJson(t, "/cli/link/start", {});
  expect(res.status).toBe(200);
  return (await res.json()) as StartBody;
}

// Full happy-path handshake over the real HTTP surface: start, approve as
// alice for a fresh org, poll out the tokens.
async function fullHandshake(t: Harness) {
  const asAlice = t.withIdentity(alice);
  const { organizationId } = await asAlice.mutation(api.organizations.create, {
    name: "Lab",
  });
  const start = await httpStart(t);
  await asAlice.mutation(api.cliLinks.approve, {
    code: start.userCode,
    organizationId,
  });
  const poll = await postJson(t, "/cli/link/poll", {
    deviceCode: start.deviceCode,
  });
  expect(poll.status).toBe(200);
  const approved = (await poll.json()) as ApprovedBody;
  expect(approved.status).toBe("approved");
  return { t, asAlice, organizationId, start, approved };
}

async function linkRowByDigest(t: Harness, digest: string) {
  return await t.run(async (ctx) => {
    return await ctx.db
      .query("cliLinks")
      .withIndex("by_refresh", (q) => q.eq("refreshToken", digest))
      .unique();
  });
}

describe("device code vs user code (RFC 8628 split)", () => {
  test("start returns two distinct values and only the user code rides the URL", async () => {
    const t = setup();
    const start = await httpStart(t);
    expect(start.deviceCode).toBeTruthy();
    expect(start.userCode).toBeTruthy();
    expect(start.deviceCode).not.toBe(start.userCode);
    expect(start.verifyPath).toContain(encodeURIComponent(start.userCode));
    expect(start.verifyPath).not.toContain(start.deviceCode);
    expect(start.interval).toBeGreaterThan(0);
  });

  test("a third party who saw the URL (user code) cannot poll out tokens", async () => {
    const t = setup();
    const asAlice = t.withIdentity(alice);
    const { organizationId } = await asAlice.mutation(
      api.organizations.create,
      { name: "Lab" },
    );
    const start = await httpStart(t);
    await asAlice.mutation(api.cliLinks.approve, {
      code: start.userCode,
      organizationId,
    });

    // Poll with the value from the URL: refused, and indistinguishable from a
    // code that never existed.
    const stolenPoll = await postJson(t, "/cli/link/poll", {
      deviceCode: start.userCode,
    });
    expect(stolenPoll.status).toBe(404);
    // Nor is it a refresh credential.
    const stolenRefresh = await postJson(t, "/cli/link/refresh", {
      refreshToken: start.userCode,
    });
    expect(stolenRefresh.status).toBe(401);

    // The legitimate holder of the device code is unaffected.
    const poll = await postJson(t, "/cli/link/poll", {
      deviceCode: start.deviceCode,
    });
    expect(poll.status).toBe(200);
    const approved = (await poll.json()) as ApprovedBody;
    expect(approved.accessToken).toBeTruthy();
    expect(approved.refreshToken).toBeTruthy();
    expect(approved.organizationId).toBe(organizationId);
  });

  // Regression: `dftstream login` printed "logged in" without naming the
  // org it now acts in; the poll response carries what it needs to say so.
  test("the approved poll names the bound organization", async () => {
    const { t, organizationId, approved } = await fullHandshake(setup());
    const org = await t.run(async (ctx) => await ctx.db.get(organizationId));
    expect(approved.organizationName).toBe("Lab");
    expect(approved.organizationSlug).toBe(org!.slug);
  });

  test("the user code is retired at consume and cannot be re-approved", async () => {
    const { asAlice, organizationId, start } = await fullHandshake(setup());
    await expect(
      asAlice.mutation(api.cliLinks.approve, {
        code: start.userCode,
        organizationId,
      }),
    ).rejects.toThrow(/unknown link code/);
  });
});

describe("refresh token storage and rotation", () => {
  test("the database stores only the sha256 digest, never the plaintext", async () => {
    const { t, approved } = await fullHandshake(setup());
    const digest = await sha256Hex(approved.refreshToken);
    const row = await linkRowByDigest(t, digest);
    expect(row).not.toBeNull();
    expect(row!.refreshToken).toBe(digest);
    expect(row!.refreshToken).not.toBe(approved.refreshToken);
    // Nothing anywhere in the row equals the plaintext secret.
    expect(JSON.stringify(row)).not.toContain(approved.refreshToken);
  });

  test("refresh rotates the token; replaying the superseded one after the grace window revokes the chain", async () => {
    const { t, approved } = await fullHandshake(setup());
    const rt0 = approved.refreshToken;

    const first = await postJson(t, "/cli/link/refresh", { refreshToken: rt0 });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      accessToken: string;
      refreshToken?: string;
    };
    expect(firstBody.accessToken).toBeTruthy();
    const rt1 = firstBody.refreshToken;
    expect(rt1).toBeTruthy();
    expect(rt1).not.toBe(rt0);

    // Age the rotation past the concurrent-refresh grace window, then replay
    // the superseded token: that is the stolen-credential signature.
    const rt1Digest = await sha256Hex(rt1!);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("cliLinks")
        .withIndex("by_refresh", (q) => q.eq("refreshToken", rt1Digest))
        .unique();
      await ctx.db.patch(row!._id, {
        rotatedAt: Date.now() - ROTATION_GRACE_MS - 1000,
      });
    });
    const replay = await postJson(t, "/cli/link/refresh", {
      refreshToken: rt0,
    });
    expect(replay.status).toBe(401);

    // The whole link is dead: the CURRENT token no longer works either.
    const row = await linkRowByDigest(t, rt1Digest);
    expect(row!.revokedAt).toBeDefined();
    const afterKill = await postJson(t, "/cli/link/refresh", {
      refreshToken: rt1,
    });
    expect(afterKill.status).toBe(401);
  });

  test("a concurrent refresh inside the grace window is honored without a second rotation", async () => {
    const { t, approved } = await fullHandshake(setup());
    const rt0 = approved.refreshToken;

    const winner = await postJson(t, "/cli/link/refresh", {
      refreshToken: rt0,
    });
    expect(winner.status).toBe(200);
    const rt1 = ((await winner.json()) as { refreshToken?: string })
      .refreshToken;
    expect(rt1).toBeTruthy();

    // The losing parallel process presents the token that was just rotated
    // out: it still gets an access token, but NO new refresh token (it must
    // keep using the winner's, which is what is on disk on a shared host).
    const loser = await postJson(t, "/cli/link/refresh", { refreshToken: rt0 });
    expect(loser.status).toBe(200);
    const loserBody = (await loser.json()) as {
      accessToken: string;
      refreshToken?: string;
    };
    expect(loserBody.accessToken).toBeTruthy();
    expect(loserBody.refreshToken).toBeUndefined();

    // No compromise was declared and the winner's token still refreshes.
    const rt1Digest = await sha256Hex(rt1!);
    const row = await linkRowByDigest(t, rt1Digest);
    expect(row!.revokedAt).toBeUndefined();
    const next = await postJson(t, "/cli/link/refresh", { refreshToken: rt1 });
    expect(next.status).toBe(200);
  });
});

describe("throttling the unauthenticated surface", () => {
  test("polling under the minimum interval gets slow_down without losing the slot", async () => {
    const t = setup();
    const start = await httpStart(t);

    const first = await postJson(t, "/cli/link/poll", {
      deviceCode: start.deviceCode,
    });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { status: string }).status).toBe("pending");

    // Immediate re-poll: throttled.
    const tooSoon = await postJson(t, "/cli/link/poll", {
      deviceCode: start.deviceCode,
    });
    expect(tooSoon.status).toBe(429);
    expect(((await tooSoon.json()) as { error: string }).error).toBe(
      "slow_down",
    );

    // A compliant client that waited the interval is served again — the
    // throttled attempt must not have advanced the window.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("cliLinks")
        .withIndex("by_code", (q) => q.eq("code", start.deviceCode))
        .unique();
      await ctx.db.patch(row!._id, {
        lastPollAt: Date.now() - MIN_POLL_INTERVAL_MS - 100,
      });
    });
    const afterWait = await postJson(t, "/cli/link/poll", {
      deviceCode: start.deviceCode,
    });
    expect(afterWait.status).toBe(200);
  });

  test("a handshake polled past the hard cap is destroyed", async () => {
    const t = setup();
    const start = await httpStart(t);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("cliLinks")
        .withIndex("by_code", (q) => q.eq("code", start.deviceCode))
        .unique();
      await ctx.db.patch(row!._id, { pollCount: MAX_POLLS });
    });
    const capped = await postJson(t, "/cli/link/poll", {
      deviceCode: start.deviceCode,
    });
    expect(capped.status).toBe(410);
    // The row is gone: further polls learn nothing, not even "expired".
    const after = await postJson(t, "/cli/link/poll", {
      deviceCode: start.deviceCode,
    });
    expect(after.status).toBe(404);
  });

  test("a burst of anonymous starts hits the pending cap; the sweep frees it", async () => {
    const t = setup();
    for (let i = 0; i < MAX_PENDING_LINKS; i++) {
      const id = await t.mutation(internal.cliLinks.start, {
        code: `burst-${i}`,
      });
      expect(id).not.toBeNull();
    }
    const capped = await postJson(t, "/cli/link/start", {});
    expect(capped.status).toBe(429);

    // Expire the burst and run the cron sweep: the endpoint reopens.
    await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("cliLinks")
        .withIndex("by_status_expiresAt", (q) =>
          q.eq("status", CLI_LINK_STATUS.PENDING),
        )
        .collect();
      for (const row of rows) {
        await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
      }
    });
    await t.mutation(internal.cliLinks.sweep, {});
    const reopened = await postJson(t, "/cli/link/start", {});
    expect(reopened.status).toBe(200);
  });
});

describe("revoke is browser-only", () => {
  test("a CLI token cannot revoke sessions — not even its own", async () => {
    const { t, asAlice, organizationId, approved } = await fullHandshake(
      setup(),
    );
    const digest = await sha256Hex(approved.refreshToken);
    const row = await linkRowByDigest(t, digest);
    const sessions = await asAlice.query(api.cliLinks.listMine, {});
    expect(sessions).toHaveLength(1);

    const asCli = t.withIdentity({
      subject: `cli|${row!.appUserId}|${organizationId}`,
      issuer: CLI_ISSUER,
    });
    await expect(
      asCli.mutation(api.cliLinks.revoke, { linkId: sessions[0]!.linkId }),
    ).rejects.toThrow(/browser session/);

    // The session is untouched and the browser owner can still revoke it.
    expect(
      (await linkRowByDigest(t, digest))!.revokedAt,
    ).toBeUndefined();
    await asAlice.mutation(api.cliLinks.revoke, {
      linkId: sessions[0]!.linkId,
    });
    expect((await linkRowByDigest(t, digest))!.revokedAt).toBeDefined();
  });
});

describe("CLI link HTTP body validation", () => {
  test("poll and refresh answer a malformed body with 400, not 500", async () => {
    const t = setup();
    for (const path of ["/cli/link/poll", "/cli/link/refresh"]) {
      const bad = await t.fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(bad.status).toBe(400);
      expect((await postJson(t, path, { deviceCode: 7, refreshToken: 7 })).status).toBe(400);
      expect((await postJson(t, path, {})).status).toBe(400);
    }
  });
});

describe("signing key checked before any state change", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("start answers 503 naming the missing key instead of starting a doomed login", async () => {
    const t = setup();
    vi.stubEnv("JWT_PRIVATE_KEY", "");
    const res = await postJson(t, "/cli/link/start", {});
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/JWT_PRIVATE_KEY/);
  });

  test("poll does not consume an approved handshake it cannot sign a token for", async () => {
    const t = setup();
    const asAlice = t.withIdentity(alice);
    const { organizationId } = await asAlice.mutation(api.organizations.create, {
      name: "Lab",
    });
    const start = await httpStart(t);
    await asAlice.mutation(api.cliLinks.approve, { code: start.userCode, organizationId });

    vi.stubEnv("JWT_PRIVATE_KEY", "not a pem");
    const broken = await postJson(t, "/cli/link/poll", { deviceCode: start.deviceCode });
    expect(broken.status).toBe(503);
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("cliLinks")
        .withIndex("by_code", (q) => q.eq("code", start.deviceCode))
        .unique(),
    );
    // Before: the link was consumed, then minting threw a 500 — the login
    // was lost and the next poll said "already used".
    expect(row!.status).toBe(CLI_LINK_STATUS.APPROVED);

    vi.unstubAllEnvs();
    const ok = await postJson(t, "/cli/link/poll", { deviceCode: start.deviceCode });
    expect(ok.status).toBe(200);
  });

  test("refresh does not rotate a token it cannot answer with", async () => {
    const { t, approved } = await fullHandshake(setup());
    const digest = await sha256Hex(approved.refreshToken);

    vi.stubEnv("JWT_PRIVATE_KEY", "");
    const res = await postJson(t, "/cli/link/refresh", {
      refreshToken: approved.refreshToken,
    });
    expect(res.status).toBe(503);
    // The stored digest is untouched, so the holder's token is still current
    // (before: it was rotated out and later replay revoked the session).
    const row = await linkRowByDigest(t, digest);
    expect(row).not.toBeNull();
    expect(row!.prevRefreshToken).toBeUndefined();

    vi.unstubAllEnvs();
    const ok = await postJson(t, "/cli/link/refresh", {
      refreshToken: approved.refreshToken,
    });
    expect(ok.status).toBe(200);
  });
});

describe("user code as typed by a human", () => {
  test("normalizeUserCode canonicalizes case, spacing and the missing dash", () => {
    expect(normalizeUserCode("bcdf-ghjk")).toBe("BCDF-GHJK");
    expect(normalizeUserCode(" bcdfghjk ")).toBe("BCDF-GHJK");
    expect(normalizeUserCode("BCDF GHJK")).toBe("BCDF-GHJK");
    expect(normalizeUserCode("BCDF-GHJK")).toBe("BCDF-GHJK");
  });

  test("approving with the code in lowercase and without the dash works", async () => {
    const t = setup();
    const asAlice = t.withIdentity(alice);
    const { organizationId } = await asAlice.mutation(api.organizations.create, {
      name: "Lab",
    });
    const start = await httpStart(t);
    const typed = start.userCode.replace("-", "").toLowerCase();
    await asAlice.mutation(api.cliLinks.approve, { code: typed, organizationId });
    const poll = await postJson(t, "/cli/link/poll", { deviceCode: start.deviceCode });
    expect(poll.status).toBe(200);
  });
});

describe("offboarding revokes CLI sessions for good", () => {
  test("removing a member revokes their session; re-adding them does not revive it", async () => {
    const t = setup();
    const asOwner = t.withIdentity({ subject: "owner", issuer: "test", email: "owner@lab.edu" });
    const asAlice = t.withIdentity(alice);
    const { organizationId } = await asOwner.mutation(api.organizations.create, {
      name: "Lab",
    });
    await asAlice.mutation(api.users.ensureSelf, {});
    await asOwner.mutation(api.organizations.addMember, {
      organizationId,
      email: "alice@lab.edu",
      role: "member",
    });
    const start = await httpStart(t);
    await asAlice.mutation(api.cliLinks.approve, { code: start.userCode, organizationId });
    const approved = (await (
      await postJson(t, "/cli/link/poll", { deviceCode: start.deviceCode })
    ).json()) as ApprovedBody;

    // A second handshake approved but not yet picked up by the CLI.
    const pending = await httpStart(t);
    await asAlice.mutation(api.cliLinks.approve, { code: pending.userCode, organizationId });

    const members = await asOwner.query(api.organizations.members, { organizationId });
    const aliceMembership = members.find((m) => m.email === "alice@lab.edu")!;
    await asOwner.mutation(api.organizations.removeMember, {
      membershipId: aliceMembership.membershipId,
    });
    await asOwner.mutation(api.organizations.addMember, {
      organizationId,
      email: "alice@lab.edu",
      role: "member",
    });

    // Before: membership was only checked live, so the re-add revived it.
    const refresh = await postJson(t, "/cli/link/refresh", {
      refreshToken: approved.refreshToken,
    });
    expect(refresh.status).toBe(401);
    const late = await postJson(t, "/cli/link/poll", { deviceCode: pending.deviceCode });
    expect(late.status).toBe(409);
  });
});

describe("dead sessions are swept", () => {
  test("the cron sweep deletes consumed sessions past their refresh ceiling, keeps live ones", async () => {
    const { t, approved } = await fullHandshake(setup());
    const digest = await sha256Hex(approved.refreshToken);
    const live = await linkRowByDigest(t, digest);
    const DAY = 24 * 60 * 60 * 1000;
    // A second session, approved and consumed 31 days ago.
    const oldId = await t.run(async (ctx) =>
      ctx.db.insert("cliLinks", {
        code: "old-device",
        status: CLI_LINK_STATUS.CONSUMED,
        appUserId: live!.appUserId,
        organizationId: live!.organizationId,
        refreshToken: "old-digest",
        createdAt: Date.now() - 31 * DAY,
        expiresAt: Date.now() - 31 * DAY,
        refreshExpiresAt: Date.now() - DAY,
      }),
    );
    await t.mutation(internal.cliLinks.sweep, {});
    expect(await t.run(async (ctx) => ctx.db.get(oldId))).toBeNull();
    expect(await linkRowByDigest(t, digest)).not.toBeNull();
  });
});
