/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema, { ARTIFACT_KIND } from "./schema";
import type { Id } from "./_generated/dataModel";

// Security-contract tests for artifact bodies and quotas (P0-9):
//
//   1. No public function ever returns a storageId or a signed storage URL.
//      Convex signed URLs never expire and file storage has no per-org ACL,
//      so either one in a query result is a PERMANENT read capability that
//      outlives org membership (docs/auth.md T4).
//   2. Bodies are served only by GET /api/artifact, which authenticates the
//      caller and re-runs the membership gate on every request — an
//      ex-member's next fetch fails, whatever they recorded while a member.
//   3. Server-side quotas: per-artifact byte cap, per-run artifact-count cap,
//      per-org total-bytes quota — measured against the ACTUAL stored blob
//      sizes (the _storage system table), not client-claimed metadata — and
//      the accounting is released again on delete.

const modules = import.meta.glob("./**/*.ts");

const alice = { subject: "alice", issuer: "test", email: "alice@lab.edu" };
const bob = { subject: "bob", issuer: "test", email: "bob@lab.edu" };

// vitest.config.ts pins this; bodyUrl must be built from it.
const SITE_URL = "https://test.convex.site";

// setAll returns one id per item it wrote; an empty result must fail the test
// here rather than propagate an undefined id into the assertions.
function noArtifact(): never {
  throw new Error("setAll returned no artifact id");
}

function setup() {
  return convexTest(schema, modules);
}

type Harness = ReturnType<typeof setup>;

async function storeBlob(t: Harness, bytes: string) {
  return await t.run(async (ctx) => await ctx.storage.store(new Blob([bytes])));
}

function item(
  name: string,
  overrides: Partial<{
    kind: string;
    sizeBytes: number;
    contentText: string;
    storageId: Id<"_storage">;
  }> = {},
) {
  return {
    name,
    path: `/host/${name}`,
    kind: overrides.kind ?? ARTIFACT_KIND.OUTPUT,
    sizeBytes: overrides.sizeBytes ?? 10,
    mtime: 1,
    contentText: overrides.contentText,
    storageId: overrides.storageId,
  };
}

// One org, one run, and Bob as a second (removable) member — the T4 fixture.
async function lab() {
  const t = setup();
  const asAlice = t.withIdentity(alice);
  const asBob = t.withIdentity(bob);
  const { organizationId } = await asAlice.mutation(api.organizations.create, {
    name: "Lab",
  });
  // Bob signs in once (provisions his appUsers row + email), then Alice adds
  // him. The "test" issuer differs from CONVEX_SITE_URL, so his email counts
  // as provider-verified and the add grants immediately.
  await asBob.mutation(api.users.ensureSelf, {});
  const added = await asAlice.mutation(api.organizations.addMember, {
    organizationId,
    email: bob.email,
    role: "member",
  });
  if (added.status !== "added") throw new Error("expected immediate grant");
  const experimentId = await asAlice.mutation(api.experiments.ensure, {
    name: "exp",
    organizationId,
  });
  const runId = await asAlice.mutation(api.runs.create, { experimentId });
  return {
    t,
    asAlice,
    asBob,
    organizationId,
    experimentId,
    runId,
    bobMembershipId: added.membershipId,
  };
}

async function orgUsageBytes(t: Harness, organizationId: Id<"organizations">) {
  return await t.run(async (ctx) => {
    const row = await ctx.db
      .query("orgUsage")
      .withIndex("by_org", (q) => q.eq("organizationId", organizationId))
      .unique();
    return row?.artifactBytes ?? 0;
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("artifact body route (T4: access dies with membership)", () => {
  test("a member can fetch the body; the bytes round-trip", async () => {
    const { t, asAlice, asBob, runId } = await lab();
    const storageId = await storeBlob(t, "TOTAL RUN TIME: 0 days");
    const [artifactId = noArtifact()] = await asAlice.mutation(api.artifacts.setAll, {
      runId,
      items: [item("job.out", { storageId, sizeBytes: 22 })],
    });
    const res = await asBob.fetch(`/api/artifact?id=${artifactId}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("TOTAL RUN TIME: 0 days");
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });

  test("an ex-member's fetch is refused on the next request", async () => {
    const { t, asAlice, asBob, runId, bobMembershipId } = await lab();
    const storageId = await storeBlob(t, "org secret");
    const [artifactId = noArtifact()] = await asAlice.mutation(api.artifacts.setAll, {
      runId,
      items: [item("job.out", { storageId })],
    });
    // While a member, Bob reads it fine — and records the URL.
    expect((await asBob.fetch(`/api/artifact?id=${artifactId}`)).status).toBe(200);
    await asAlice.mutation(api.organizations.removeMember, {
      membershipId: bobMembershipId,
    });
    // The recorded URL is dead: the gate re-runs per request.
    const res = await asBob.fetch(`/api/artifact?id=${artifactId}`);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("org secret");
    // And the metadata query dies with it.
    await expect(
      asBob.query(api.artifacts.getContent, { artifactId }),
    ).rejects.toThrow(/not a member/);
  });

  test("anonymous and garbage requests get 401 / 400 / 404, never bytes", async () => {
    const { t, asAlice, runId } = await lab();
    const storageId = await storeBlob(t, "body");
    const [artifactId = noArtifact()] = await asAlice.mutation(api.artifacts.setAll, {
      runId,
      items: [item("job.out", { storageId })],
    });
    expect((await t.fetch(`/api/artifact?id=${artifactId}`)).status).toBe(401);
    expect((await asAlice.fetch(`/api/artifact`)).status).toBe(400);
    expect((await asAlice.fetch(`/api/artifact?id=not-an-id`)).status).toBe(404);
  });

  test("CORS preflight answers without authentication and without data", async () => {
    const { t } = await lab();
    const res = await t.fetch("/api/artifact", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain(
      "Authorization",
    );
    expect(await res.text()).toBe("");
  });
});

describe("no public function returns a storage capability", () => {
  test("getContent / get / listForRun / getVibModesForRun leak neither storageId nor URL", async () => {
    const { t, asAlice, runId } = await lab();
    const storageId = await storeBlob(t, "big body");
    const vibStorageId = await storeBlob(t, "vib body");
    const [artifactId = noArtifact()] = await asAlice.mutation(api.artifacts.setAll, {
      runId,
      items: [
        item("job.out", { storageId }),
        item("job.v001.xyz", { kind: ARTIFACT_KIND.VIBMODE, storageId: vibStorageId }),
      ],
    });

    const content = await asAlice.query(api.artifacts.getContent, { artifactId });
    expect(content).not.toBeNull();
    expect(content).not.toHaveProperty("storageId");
    expect(content).not.toHaveProperty("url");
    expect(content!.bodyUrl).toBe(`${SITE_URL}/api/artifact?id=${artifactId}`);

    const listed = await asAlice.query(api.artifacts.listForRun, { runId });
    const vibs = await asAlice.query(api.artifacts.getVibModesForRun, { runId });
    expect(vibs).toHaveLength(1);
    expect(vibs[0]).not.toHaveProperty("storageId");
    expect(vibs[0]).not.toHaveProperty("url");
    expect(vibs[0]!.bodyUrl).toContain("/api/artifact?id=");

    // Belt and braces: neither raw storage id appears anywhere in any public
    // result, under any key name.
    const everything = JSON.stringify([content, listed, vibs]);
    expect(everything).not.toContain(storageId);
    expect(everything).not.toContain(vibStorageId);
  });
});

describe("server-side quotas", () => {
  test("per-artifact byte cap measures the ACTUAL blob, not claimed metadata", async () => {
    vi.stubEnv("DFTSTREAM_MAX_ARTIFACT_BYTES", "8");
    const { t, asAlice, runId } = await lab();
    const storageId = await storeBlob(t, "123456789"); // 9 bytes stored
    await expect(
      asAlice.mutation(api.artifacts.appendToRun, {
        runId,
        // The claimed sizeBytes lies small; the server must not believe it.
        items: [item("big.out", { storageId, sizeBytes: 1 })],
      }),
    ).rejects.toThrow(/per-artifact cap/);
    // Inline text is capped the same way.
    await expect(
      asAlice.mutation(api.artifacts.appendToRun, {
        runId,
        items: [item("inline.out", { contentText: "123456789" })],
      }),
    ).rejects.toThrow(/per-artifact cap/);
    // At the cap is fine.
    await asAlice.mutation(api.artifacts.appendToRun, {
      runId,
      items: [item("ok.out", { contentText: "12345678" })],
    });
  });

  test("per-run artifact count cap", async () => {
    vi.stubEnv("DFTSTREAM_MAX_RUN_ARTIFACTS", "2");
    const { asAlice, runId } = await lab();
    await asAlice.mutation(api.artifacts.appendToRun, {
      runId,
      items: [item("a.out", { contentText: "a" }), item("b.out", { contentText: "b" })],
    });
    await expect(
      asAlice.mutation(api.artifacts.appendToRun, {
        runId,
        items: [item("c.out", { contentText: "c" })],
      }),
    ).rejects.toThrow(/per-run cap/);
    // setAll REPLACES, so a fresh manifest at the cap is accepted.
    await asAlice.mutation(api.artifacts.setAll, {
      runId,
      items: [item("d.out", { contentText: "d" }), item("e.out", { contentText: "e" })],
    });
  });

  test("org quota rejects, and deleting an artifact releases its bytes", async () => {
    vi.stubEnv("DFTSTREAM_ORG_STORAGE_QUOTA_BYTES", "20");
    const { t, asAlice, organizationId, runId } = await lab();
    const big = await storeBlob(t, "x".repeat(15));
    const [firstId] = await asAlice.mutation(api.artifacts.appendToRun, {
      runId,
      items: [item("first.out", { storageId: big, sizeBytes: 15 })],
    });
    expect(await orgUsageBytes(t, organizationId)).toBe(15);

    const second = await storeBlob(t, "y".repeat(10));
    await expect(
      asAlice.mutation(api.artifacts.appendToRun, {
        runId,
        items: [item("second.out", { storageId: second, sizeBytes: 10 })],
      }),
    ).rejects.toThrow(/storage quota exceeded/);

    // Deleting the first artifact settles the accounting…
    await asAlice.mutation(api.artifacts.remove, { artifactId: firstId! });
    expect(await orgUsageBytes(t, organizationId)).toBe(0);
    // …and the rejected upload now fits.
    await asAlice.mutation(api.artifacts.appendToRun, {
      runId,
      items: [item("second.out", { storageId: second, sizeBytes: 10 })],
    });
    expect(await orgUsageBytes(t, organizationId)).toBe(10);
  });

  test("deleting the run settles the org's usage in the same transaction", async () => {
    const { t, asAlice, organizationId, runId } = await lab();
    const storageId = await storeBlob(t, "z".repeat(12));
    await asAlice.mutation(api.artifacts.appendToRun, {
      runId,
      items: [item("job.out", { storageId, sizeBytes: 12 })],
    });
    expect(await orgUsageBytes(t, organizationId)).toBe(12);
    await asAlice.mutation(api.runs.remove, { runId });
    // Settled by the run pop itself — before any async child drain runs.
    expect(await orgUsageBytes(t, organizationId)).toBe(0);
  });

  test("a malformed quota override fails closed instead of being ignored", async () => {
    vi.stubEnv("DFTSTREAM_ORG_STORAGE_QUOTA_BYTES", "twenty");
    const { asAlice, runId } = await lab();
    await expect(
      asAlice.mutation(api.artifacts.appendToRun, {
        runId,
        items: [item("a.out", { contentText: "a" })],
      }),
    ).rejects.toThrow(/not a valid limit/);
  });
});

describe("storageId rotation (pre-fix leaked URLs)", () => {
  test("rotation swaps the blob id, kills the old blob, and keeps the bytes", async () => {
    const { t, asAlice, runId } = await lab();
    const oldStorageId = await storeBlob(t, "immortal-url body");
    const [artifactId = noArtifact()] = await asAlice.mutation(api.artifacts.setAll, {
      runId,
      items: [item("job.out", { storageId: oldStorageId })],
    });

    await t.action(internal.artifacts.rotateStorageIdsNow, {});

    const { newStorageId, oldBlobGone } = await t.run(async (ctx) => {
      const row = await ctx.db.get(artifactId!);
      return {
        newStorageId: row?.storageId,
        oldBlobGone: (await ctx.storage.get(oldStorageId)) === null,
      };
    });
    // Any URL signed for the old blob is now dead…
    expect(oldBlobGone).toBe(true);
    expect(newStorageId).toBeDefined();
    expect(newStorageId).not.toBe(oldStorageId);
    // …while the gated route still serves the identical bytes.
    const res = await asAlice.fetch(`/api/artifact?id=${artifactId}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("immortal-url body");
  });
});
