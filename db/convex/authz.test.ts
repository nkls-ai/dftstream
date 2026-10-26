/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

// Distinct mocked identities. convex-test derives a stable tokenIdentifier from
// (issuer, subject), which is exactly what authz.currentUserId keys on.
const alice = { subject: "alice", issuer: "test", email: "alice@lab.edu" };
const bob = { subject: "bob", issuer: "test", email: "bob@lab.edu" };
const carol = { subject: "carol", issuer: "test", email: "carol@lab.edu" };

// The issuer authz.parseCliSubject trusts for `cli|` subjects — it must equal
// CONVEX_SITE_URL, which vitest.config.ts pins for the suite.
const CLI_ISSUER = "https://test.convex.site";

function setup() {
  return convexTest(schema, modules);
}

type Harness = ReturnType<typeof setup>;

// Two tenants that share a deployment and nothing else. Alice owns org A and
// has a full experiment→run→artifact chain in it; Bob owns org B and has a run
// of his own to hang stolen ids off. This is the fixture every cross-tenant
// test below works against.
async function twoTenants() {
  const t = setup();
  const asAlice = t.withIdentity(alice);
  const asBob = t.withIdentity(bob);

  const orgA = (await asAlice.mutation(api.organizations.create, { name: "Lab A" }))
    .organizationId;
  const orgB = (await asBob.mutation(api.organizations.create, { name: "Lab B" }))
    .organizationId;

  const expA = await asAlice.mutation(api.experiments.ensure, {
    name: "exp-a",
    organizationId: orgA,
  });
  const runA = await asAlice.mutation(api.runs.create, { experimentId: expA });
  const batchA = await asAlice.mutation(api.experiments.createBatch, {
    experimentId: expA,
    name: "batch-a",
  });
  const pathwayA = await asAlice.mutation(api.pathways.create, {
    experimentId: expA,
    name: "path-a",
    points: [{ runId: runA, role: "reactant" as const, order: 0 }],
  });

  const expB = await asBob.mutation(api.experiments.ensure, {
    name: "exp-b",
    organizationId: orgB,
  });
  const runB = await asBob.mutation(api.runs.create, { experimentId: expB });

  return { t, asAlice, asBob, orgA, orgB, expA, runA, batchA, pathwayA, expB, runB };
}

async function storeBlob(t: Harness, bytes: string) {
  return await t.run(async (ctx) => await ctx.storage.store(new Blob([bytes])));
}

const artifactItem = (storageId: string) => ({
  name: "big.out",
  path: "/host/big.out",
  kind: "output",
  sizeBytes: 4096,
  mtime: 1,
  storageId: storageId as never,
});

describe("organization isolation + roles", () => {
  test("creator becomes owner and sees their org", async () => {
    const t = setup();
    const asAlice = t.withIdentity(alice);
    const { organizationId } = await asAlice.mutation(api.organizations.create, {
      name: "Lab",
    });
    const orgs = await asAlice.query(api.organizations.myOrgs, {});
    expect(orgs).toHaveLength(1);
    expect(orgs[0]).toMatchObject({ organizationId, role: "owner" });
  });

  test("non-members cannot read or write another org's data", async () => {
    const t = setup();
    const asAlice = t.withIdentity(alice);
    const asBob = t.withIdentity(bob);
    const { organizationId } = await asAlice.mutation(api.organizations.create, {
      name: "Lab",
    });
    await asAlice.mutation(api.experiments.ensure, {
      name: "exp1",
      organizationId,
    });

    // Bob belongs to no org.
    expect(await asBob.query(api.organizations.myOrgs, {})).toEqual([]);
    await expect(
      asBob.query(api.experiments.list, { organizationId }),
    ).rejects.toThrow(/not a member/);
    await expect(
      asBob.mutation(api.experiments.ensure, { name: "x", organizationId }),
    ).rejects.toThrow(/not a member/);
  });

  test("viewer can read but not write; member can write", async () => {
    const t = setup();
    const asAlice = t.withIdentity(alice);
    const asBob = t.withIdentity(bob);
    const asCarol = t.withIdentity(carol);
    const { organizationId } = await asAlice.mutation(api.organizations.create, {
      name: "Lab",
    });
    // Bob & Carol must provision themselves before they can be added by email.
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
      role: "member",
    });

    // Viewer reads OK, writes rejected.
    expect(
      await asBob.query(api.experiments.list, { organizationId }),
    ).toEqual([]);
    await expect(
      asBob.mutation(api.experiments.ensure, { name: "x", organizationId }),
    ).rejects.toThrow(/insufficient permission/);

    // Member can create.
    const expId = await asCarol.mutation(api.experiments.ensure, {
      name: "carol-exp",
      organizationId,
    });
    expect(expId).toBeDefined();
  });

  test("members delete their own data but not others'; admins delete any", async () => {
    const t = setup();
    const asAlice = t.withIdentity(alice);
    const asCarol = t.withIdentity(carol);
    const { organizationId } = await asAlice.mutation(api.organizations.create, {
      name: "Lab",
    });
    await asCarol.mutation(api.users.ensureSelf, {});
    await asAlice.mutation(api.organizations.addMember, {
      organizationId,
      email: "carol@lab.edu",
      role: "member",
    });

    // Alice (owner) creates an experiment; Carol (member) may not delete it.
    const aliceExp = await asAlice.mutation(api.experiments.ensure, {
      name: "alice-exp",
      organizationId,
    });
    await expect(
      asCarol.mutation(api.experiments.remove, { experimentId: aliceExp }),
    ).rejects.toThrow(/insufficient permission/);

    // Carol may delete her own.
    const carolExp = await asCarol.mutation(api.experiments.ensure, {
      name: "carol-exp",
      organizationId,
    });
    await asCarol.mutation(api.experiments.remove, { experimentId: carolExp });
    expect(await asAlice.query(api.experiments.get, { id: carolExp })).toBeNull();

    // Admin (Alice) deletes Carol's-equivalent / her own freely.
    await asAlice.mutation(api.experiments.remove, { experimentId: aliceExp });
  });

  test("importUnassignedNow (owner-only/internal) claims pre-auth org-less experiments", async () => {
    const t = setup();
    // Simulate a legacy row with no organizationId by inserting directly.
    const orphanId = await t.run(async (ctx) => {
      return await ctx.db.insert("experiments", {
        name: "legacy",
        createdAt: 1,
      });
    });
    const asAlice = t.withIdentity(alice);
    const { organizationId } = await asAlice.mutation(api.organizations.create, {
      name: "Lab",
    });
    // Internal mutation — invoked by the deployment owner (here directly), not
    // reachable from the client.
    await t.mutation(internal.organizations.importUnassignedNow, {
      organizationId,
    });
    const claimed = await asAlice.query(api.experiments.get, { id: orphanId });
    expect(claimed?.organizationId).toBe(organizationId);
  });

  test("an org must keep at least one owner", async () => {
    const t = setup();
    const asAlice = t.withIdentity(alice);
    const { organizationId } = await asAlice.mutation(api.organizations.create, {
      name: "Lab",
    });
    const members = await asAlice.query(api.organizations.members, {
      organizationId,
    });
    const ownerMembership = members.find((m) => m.role === "owner")!;
    await expect(
      asAlice.mutation(api.organizations.updateRole, {
        membershipId: ownerMembership.membershipId,
        role: "member",
      }),
    ).rejects.toThrow(/at least one owner/);
  });

  test("an admin cannot remove an owner, only demote-proof owners can", async () => {
    const t = setup();
    const asAlice = t.withIdentity(alice); // owner
    const asBob = t.withIdentity(bob); // will be admin
    const asCarol = t.withIdentity(carol); // second owner
    const { organizationId } = await asAlice.mutation(api.organizations.create, {
      name: "Lab",
    });
    await asBob.mutation(api.users.ensureSelf, {});
    await asCarol.mutation(api.users.ensureSelf, {});
    await asAlice.mutation(api.organizations.addMember, {
      organizationId,
      email: "bob@lab.edu",
      role: "admin",
    });
    await asAlice.mutation(api.organizations.addMember, {
      organizationId,
      email: "carol@lab.edu",
      role: "owner",
    });

    const members = await asBob.query(api.organizations.members, {
      organizationId,
    });
    const anOwner = members.find((m) => m.email === "carol@lab.edu")!;
    // Two owners exist, so the last-owner guard does not fire — the only thing
    // standing between an admin and deleting the owners above them is the
    // role check. Without it an admin escalates by deletion.
    await expect(
      asBob.mutation(api.organizations.removeMember, {
        membershipId: anOwner.membershipId,
      }),
    ).rejects.toThrow(/only an owner can remove an owner/);

    // An actual owner may.
    await asAlice.mutation(api.organizations.removeMember, {
      membershipId: anOwner.membershipId,
    });
  });
});

// =============================================================================
// IDOR: holding another tenant's id must not be enough
// =============================================================================

describe("cross-tenant id access (IDOR)", () => {
  test("every run/experiment-scoped read rejects another org's id", async () => {
    const { asBob, expA, runA, batchA, pathwayA } = await twoTenants();
    const denied = /not a member|insufficient permission/;

    await expect(asBob.query(api.runs.get, { runId: runA })).rejects.toThrow(denied);
    await expect(
      asBob.query(api.runs.listByExperiment, { experimentId: expA }),
    ).rejects.toThrow(denied);
    await expect(
      asBob.query(api.runs.listChildren, { runId: runA }),
    ).rejects.toThrow(denied);
    await expect(
      asBob.query(api.runs.findByExperimentAndName, {
        experimentId: expA,
        name: "x",
      }),
    ).rejects.toThrow(denied);
    await expect(
      asBob.query(api.runs.batchProgress, { batchId: batchA }),
    ).rejects.toThrow(denied);
    await expect(
      asBob.query(api.runs.listByBatchPaged, {
        batchId: batchA,
        paginationOpts: { numItems: 10, cursor: null },
      }),
    ).rejects.toThrow(denied);
    await expect(
      asBob.query(api.logs.listForRun, { runId: runA }),
    ).rejects.toThrow(denied);
    await expect(
      asBob.query(api.events.listForRun, { runId: runA }),
    ).rejects.toThrow(denied);
    await expect(
      asBob.query(api.geometries.listForRun, { runId: runA }),
    ).rejects.toThrow(denied);
    await expect(
      asBob.query(api.frequencies.getForRun, { runId: runA }),
    ).rejects.toThrow(denied);
    await expect(
      asBob.query(api.excitedStates.listForRun, { runId: runA }),
    ).rejects.toThrow(denied);
    await expect(
      asBob.query(api.nmrShields.listForRun, { runId: runA }),
    ).rejects.toThrow(denied);
    await expect(
      asBob.query(api.artifacts.listForRun, { runId: runA }),
    ).rejects.toThrow(denied);
    await expect(
      asBob.query(api.artifacts.cubeIndex, { runId: runA }),
    ).rejects.toThrow(denied);
    await expect(
      asBob.query(api.artifacts.getVibModesForRun, { runId: runA }),
    ).rejects.toThrow(denied);
    await expect(
      asBob.query(api.metrics.byRunKey, {
        runId: runA,
        key: "scf",
        paginationOpts: { numItems: 10, cursor: null },
      }),
    ).rejects.toThrow(denied);
    await expect(
      asBob.query(api.sysSamples.forRun, {
        runId: runA,
        paginationOpts: { numItems: 10, cursor: null },
      }),
    ).rejects.toThrow(denied);
    await expect(
      asBob.query(api.pathways.list, { experimentId: expA }),
    ).rejects.toThrow(denied);
    await expect(
      asBob.query(api.pathways.get, { pathwayId: pathwayA }),
    ).rejects.toThrow(denied);
  });

  test("every run-scoped write rejects another org's id", async () => {
    const { asBob, runA, pathwayA } = await twoTenants();
    const denied = /not a member|insufficient permission/;

    await expect(
      asBob.mutation(api.runs.updateStatus, { runId: runA, status: "failed" }),
    ).rejects.toThrow(denied);
    await expect(
      asBob.mutation(api.runs.setNotes, { runId: runA, notes: "pwned" }),
    ).rejects.toThrow(denied);
    await expect(
      asBob.mutation(api.runs.setTags, { runId: runA, tags: ["pwned"] }),
    ).rejects.toThrow(denied);
    await expect(
      asBob.mutation(api.runs.rename, { runId: runA, name: "pwned" }),
    ).rejects.toThrow(denied);
    await expect(
      asBob.mutation(api.runs.updateStatus, { runId: runA, lastEnergy: -1 }),
    ).rejects.toThrow(denied);
    await expect(
      asBob.mutation(api.runs.remove, { runId: runA }),
    ).rejects.toThrow(denied);
    await expect(
      asBob.mutation(api.logs.appendMany, {
        runId: runA,
        items: [{ ts: 1, level: "info", message: "x" }],
      }),
    ).rejects.toThrow(denied);
    await expect(
      asBob.mutation(api.geometries.append, { runId: runA, cycle: 1, xyz: "H" }),
    ).rejects.toThrow(denied);
    await expect(
      asBob.mutation(api.pathways.rename, { pathwayId: pathwayA, name: "x" }),
    ).rejects.toThrow(denied);
    await expect(
      asBob.mutation(api.pathways.remove, { pathwayId: pathwayA }),
    ).rejects.toThrow(denied);
  });

  test("a run cannot be reparented onto another org's run", async () => {
    const { asBob, runA, runB } = await twoTenants();
    await expect(
      asBob.mutation(api.runs.setParent, { runId: runB, parentRunId: runA }),
    ).rejects.toThrow(/different organization|not a member/);
  });

  test("a pathway cannot stitch in another org's run", async () => {
    const { asBob, runA, expB } = await twoTenants();
    await expect(
      asBob.mutation(api.pathways.create, {
        experimentId: expB,
        name: "steal",
        points: [{ runId: runA, role: "reactant" as const, order: 0 }],
      }),
    ).rejects.toThrow(/outside this organization/);
  });

  test("runs.listRunning never leaks another org's runs", async () => {
    const { asAlice, asBob, orgA, orgB, expA, expB } = await twoTenants();
    const aRunning = await asAlice.mutation(api.runs.create, {
      experimentId: expA,
    });
    await asAlice.mutation(api.runs.updateStatus, {
      runId: aRunning,
      status: "running",
    });
    const bRunning = await asBob.mutation(api.runs.create, { experimentId: expB });
    await asBob.mutation(api.runs.updateStatus, {
      runId: bRunning,
      status: "running",
    });

    const bobSees = await asBob.query(api.runs.listRunning, {
      organizationId: orgB,
    });
    expect(bobSees.map((r) => r._id)).toEqual([bRunning]);
    await expect(
      asBob.query(api.runs.listRunning, { organizationId: orgA }),
    ).rejects.toThrow(/not a member/);
  });
});

// =============================================================================
// Storage blobs: an id is not a capability
// =============================================================================

describe("storage blob ownership", () => {
  test("another org's blob cannot be attached to your own run", async () => {
    const { t, asAlice, asBob, runA, runB } = await twoTenants();
    const storageId = await storeBlob(t, "org A secret output");
    await asAlice.mutation(api.artifacts.setAll, {
      runId: runA,
      items: [artifactItem(storageId)],
    });

    // Bob knows the storageId — he was a legitimate reader once, or read it
    // off a stale client cache. Re-attaching it to HIS run would hand him a
    // signed download URL for org A's body, and let his own artifacts.remove
    // destroy it.
    for (const fn of [
      api.artifacts.appendToRun,
      api.artifacts.setAll,
      api.artifacts.upsertForRun,
    ]) {
      await expect(
        asBob.mutation(fn, { runId: runB, items: [artifactItem(storageId)] }),
      ).rejects.toThrow(/already attached/);
    }

    // Org A's artifact and its body are untouched.
    const rows = await asAlice.query(api.artifacts.listForRun, { runId: runA });
    expect(rows).toHaveLength(1);
    const body = await t.run(
      async (ctx) => await ctx.storage.getUrl(storageId as never),
    );
    expect(body).not.toBeNull();
  });

  test("deleteBlob refuses a blob that belongs to an artifact", async () => {
    const { t, asAlice, asBob, runA } = await twoTenants();
    const storageId = await storeBlob(t, "attached");
    await asAlice.mutation(api.artifacts.setAll, {
      runId: runA,
      items: [artifactItem(storageId)],
    });
    await expect(
      asBob.mutation(api.artifacts.deleteBlob, { storageId: storageId as never }),
    ).rejects.toThrow(/attached to an artifact/);
  });

  test("uploading requires belonging to an org, not merely signing in", async () => {
    const t = setup();
    const asCarol = t.withIdentity(carol); // authenticated, no memberships
    await asCarol.mutation(api.users.ensureSelf, {});
    await expect(
      asCarol.mutation(api.artifacts.generateUploadUrl, {}),
    ).rejects.toThrow(/not a member of any organization/);

    const { asAlice } = await twoTenants();
    expect(
      await asAlice.mutation(api.artifacts.generateUploadUrl, {}),
    ).toEqual(expect.any(String));
  });
});

// =============================================================================
// CLI tokens
// =============================================================================

describe("CLI tokens", () => {
  // Mints the identity http.ts would sign for (user, org) — same subject
  // shape, same issuer.
  function asCli(t: Harness, appUserId: string, organizationId: string) {
    return t.withIdentity({
      subject: `cli|${appUserId}|${organizationId}`,
      issuer: CLI_ISSUER,
    });
  }

  async function tenantsWithCli() {
    const base = await twoTenants();
    // Alice joins Bob's org too, so "the human is a member of both" is true
    // and only the token's scope can stop it.
    await base.asAlice.mutation(api.users.ensureSelf, {});
    await base.asBob.mutation(api.organizations.addMember, {
      organizationId: base.orgB,
      email: "alice@lab.edu",
      role: "member",
    });
    const aliceId = await base.asAlice.mutation(api.users.ensureSelf, {});
    return { ...base, aliceId };
  }

  test("a token acts as its user in the org it was approved for", async () => {
    const { t, aliceId, orgA, expA } = await tenantsWithCli();
    const cli = asCli(t, aliceId, orgA);
    const runId = await cli.mutation(api.runs.create, { experimentId: expA });
    expect(runId).toBeDefined();
    expect(await cli.query(api.experiments.list, { organizationId: orgA })).toHaveLength(1);
  });

  test("a token scoped to one org cannot reach the user's OTHER orgs", async () => {
    const { t, asAlice, aliceId, orgA, orgB, expB } = await tenantsWithCli();
    // Alice's browser session can reach org B — she is a genuine member.
    expect(await asAlice.query(api.experiments.list, { organizationId: orgB })).toHaveLength(1);

    // Her CLI token, approved only for org A, cannot.
    const cli = asCli(t, aliceId, orgA);
    await expect(
      cli.query(api.experiments.list, { organizationId: orgB }),
    ).rejects.toThrow(/not authorized for this organization/);
    await expect(
      cli.mutation(api.runs.create, { experimentId: expB }),
    ).rejects.toThrow(/not authorized for this organization/);
  });

  test("a `cli|` subject from another issuer cannot impersonate anyone", async () => {
    const { t, aliceId, orgA, expA } = await tenantsWithCli();
    // Mallory signs in through a second trusted provider (auth.config.ts
    // deliberately allows more than one) and simply claims Alice's subject.
    const forged = t.withIdentity({
      subject: `cli|${aliceId}|${orgA}`,
      issuer: "https://another-idp.example",
    });
    await expect(
      forged.query(api.experiments.list, { organizationId: orgA }),
    ).rejects.toThrow(/untrusted issuer/);
    await expect(
      forged.mutation(api.runs.create, { experimentId: expA }),
    ).rejects.toThrow(/untrusted issuer/);
    // The "who am I" queries answer null/[] only for a caller with NO
    // identity (the UI polls them before a session exists). A forged subject
    // is not "no session": it is refused like everywhere else, instead of
    // being swallowed into a quiet "nobody".
    await expect(forged.query(api.users.me, {})).rejects.toThrow(/untrusted issuer/);
    await expect(
      forged.query(api.organizations.myOrgs, {}),
    ).rejects.toThrow(/untrusted issuer/);
    await expect(
      forged.query(api.organizations.myRole, { organizationId: orgA }),
    ).rejects.toThrow(/untrusted issuer/);
    await expect(forged.query(api.cliLinks.listMine, {})).rejects.toThrow(
      /untrusted issuer/,
    );
  });

  test("a scoped token cannot even enumerate the user's other orgs", async () => {
    const { t, asAlice, aliceId, orgA, orgB } = await tenantsWithCli();
    // The browser session sees both memberships.
    expect(await asAlice.query(api.organizations.myOrgs, {})).toHaveLength(2);

    // The token sees only the org it was approved for. myOrgs/myRole answer
    // from `memberships` directly and never reach requireMembership, so this
    // is a separate check from the one above — and a separate way to leak.
    const cli = asCli(t, aliceId, orgA);
    const visible = await cli.query(api.organizations.myOrgs, {});
    expect(visible.map((o) => o.organizationId)).toEqual([orgA]);
    expect(await cli.query(api.organizations.myRole, { organizationId: orgA })).toBe(
      "owner",
    );
    expect(
      await cli.query(api.organizations.myRole, { organizationId: orgB }),
    ).toBeNull();
  });

  test("a CLI token cannot administer the org or mint more credentials", async () => {
    const { t, aliceId, orgA } = await tenantsWithCli();
    const cli = asCli(t, aliceId, orgA);
    const browserOnly = /requires a browser session/;

    await expect(
      cli.mutation(api.organizations.create, { name: "Sneaky" }),
    ).rejects.toThrow(browserOnly);
    await expect(
      cli.mutation(api.organizations.addMember, {
        organizationId: orgA,
        email: "bob@lab.edu",
        role: "owner",
      }),
    ).rejects.toThrow(browserOnly);
    await expect(
      cli.mutation(api.organizations.rename, {
        organizationId: orgA,
        name: "Owned",
      }),
    ).rejects.toThrow(browserOnly);
    await expect(
      cli.mutation(api.organizations.remove, { organizationId: orgA }),
    ).rejects.toThrow(browserOnly);

    // And it cannot launder itself into a fresh, separately-revocable session.
    await t.mutation(internal.cliLinks.start, { code: "code-1" });
    await expect(
      cli.mutation(api.cliLinks.approve, {
        code: "code-1",
        organizationId: orgA,
      }),
    ).rejects.toThrow(browserOnly);
  });
});

// =============================================================================
// CLI link handshake: expiry, single use, revocation
// =============================================================================

describe("CLI link lifecycle", () => {
  async function startedLink(code: string) {
    const t = setup();
    const asAlice = t.withIdentity(alice);
    const { organizationId } = await asAlice.mutation(api.organizations.create, {
      name: "Lab",
    });
    await t.mutation(internal.cliLinks.start, { code });
    return { t, asAlice, organizationId };
  }

  test("an expired code cannot be approved", async () => {
    const { t, asAlice, organizationId } = await startedLink("c1");
    // Age the row past its window.
    await t.run(async (ctx) => {
      const link = await ctx.db
        .query("cliLinks")
        .withIndex("by_code", (q) => q.eq("code", "c1"))
        .unique();
      await ctx.db.patch(link!._id, { expiresAt: Date.now() - 1 });
    });
    await expect(
      asAlice.mutation(api.cliLinks.approve, { code: "c1", organizationId }),
    ).rejects.toThrow(/expired/);
  });

  test("a code is single-use and cannot be re-bound", async () => {
    const { t, asAlice, organizationId } = await startedLink("c2");
    await asAlice.mutation(api.cliLinks.approve, {
      code: "c2",
      organizationId,
    });
    await expect(
      asAlice.mutation(api.cliLinks.approve, { code: "c2", organizationId }),
    ).rejects.toThrow(/already used/);

    const first = await t.mutation(internal.cliLinks.consume, {
      code: "c2",
      refreshToken: "rt-2",
    });
    expect(first?.organizationId).toBe(organizationId);
    // Replay of the poll gets nothing.
    expect(
      await t.mutation(internal.cliLinks.consume, {
        code: "c2",
        refreshToken: "rt-2b",
      }),
    ).toBeNull();
  });

  test("approving requires membership in the org being granted", async () => {
    const { t, asAlice, organizationId } = await startedLink("c3");
    void asAlice;
    const asBob = t.withIdentity(bob);
    await expect(
      asBob.mutation(api.cliLinks.approve, { code: "c3", organizationId }),
    ).rejects.toThrow(/not a member/);
  });

  async function liveSession(code: string, refreshToken: string) {
    const { t, asAlice, organizationId } = await startedLink(code);
    await asAlice.mutation(api.cliLinks.approve, { code, organizationId });
    await t.mutation(internal.cliLinks.consume, { code, refreshToken });
    return { t, asAlice, organizationId };
  }

  test("a revoked session can no longer refresh", async () => {
    const { t, asAlice } = await liveSession("c4", "rt-4");
    expect(
      await t.mutation(internal.cliLinks.redeemRefresh, { refreshToken: "rt-4" }),
    ).not.toBeNull();

    const sessions = await asAlice.query(api.cliLinks.listMine, {});
    expect(sessions).toHaveLength(1);
    await asAlice.mutation(api.cliLinks.revoke, { linkId: sessions[0]!.linkId });

    expect(
      await t.mutation(internal.cliLinks.redeemRefresh, { refreshToken: "rt-4" }),
    ).toBeNull();
    expect(await asAlice.query(api.cliLinks.listMine, {})).toEqual([]);
  });

  test("listMine never returns the refresh secret", async () => {
    const { asAlice } = await liveSession("c5", "rt-5");
    const sessions = await asAlice.query(api.cliLinks.listMine, {});
    expect(JSON.stringify(sessions)).not.toContain("rt-5");
  });

  test("an expired refresh token stops working", async () => {
    const { t } = await liveSession("c6", "rt-6");
    await t.run(async (ctx) => {
      const link = await ctx.db
        .query("cliLinks")
        .withIndex("by_refresh", (q) => q.eq("refreshToken", "rt-6"))
        .unique();
      await ctx.db.patch(link!._id, { refreshExpiresAt: Date.now() - 1 });
    });
    expect(
      await t.mutation(internal.cliLinks.redeemRefresh, { refreshToken: "rt-6" }),
    ).toBeNull();
  });

  test("losing org membership kills the CLI session's ability to refresh", async () => {
    const { t, asAlice, organizationId } = await liveSession("c7", "rt-7");
    // Alice is removed from the org her CLI was approved for. The access
    // token she holds dies at its own expiry; refreshing must fail at once.
    await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("memberships")
        .withIndex("by_org", (q) => q.eq("organizationId", organizationId))
        .collect();
      for (const m of rows) await ctx.db.delete(m._id);
    });
    void asAlice;
    expect(
      await t.mutation(internal.cliLinks.redeemRefresh, { refreshToken: "rt-7" }),
    ).toBeNull();
  });

  test("an org admin can revoke a member's CLI session", async () => {
    const t = setup();
    const asAlice = t.withIdentity(alice); // owner
    const asBob = t.withIdentity(bob); // member with a CLI
    const { organizationId } = await asAlice.mutation(api.organizations.create, {
      name: "Lab",
    });
    await asBob.mutation(api.users.ensureSelf, {});
    await asAlice.mutation(api.organizations.addMember, {
      organizationId,
      email: "bob@lab.edu",
      role: "member",
    });
    await t.mutation(internal.cliLinks.start, { code: "c8" });
    await asBob.mutation(api.cliLinks.approve, { code: "c8", organizationId });
    await t.mutation(internal.cliLinks.consume, {
      code: "c8",
      refreshToken: "rt-8",
    });

    const bobSessions = await asBob.query(api.cliLinks.listMine, {});
    expect(bobSessions).toHaveLength(1);
    // Offboarding: the admin does not need Bob's cooperation.
    await asAlice.mutation(api.cliLinks.revoke, {
      linkId: bobSessions[0]!.linkId,
    });
    expect(
      await t.mutation(internal.cliLinks.redeemRefresh, { refreshToken: "rt-8" }),
    ).toBeNull();
  });

  test("an unrelated user cannot revoke someone else's session", async () => {
    const { t } = await liveSession("c9", "rt-9");
    const asCarol = t.withIdentity(carol);
    await asCarol.mutation(api.users.ensureSelf, {});
    const linkId = await t.run(async (ctx) => {
      const link = await ctx.db
        .query("cliLinks")
        .withIndex("by_refresh", (q) => q.eq("refreshToken", "rt-9"))
        .unique();
      return link!._id;
    });
    await expect(
      asCarol.mutation(api.cliLinks.revoke, { linkId }),
    ).rejects.toThrow(/not a member|insufficient permission/);
    expect(
      await t.mutation(internal.cliLinks.redeemRefresh, { refreshToken: "rt-9" }),
    ).not.toBeNull();
  });
});

// =============================================================================
// Legacy (pre-auth) rows must not become world-readable when auth flips on
// =============================================================================

describe("pre-auth legacy rows under enforcement", () => {
  test("an org-less experiment and its runs are invisible to everyone", async () => {
    const t = setup();
    const { legacyExp, legacyRun } = await t.run(async (ctx) => {
      const legacyExp = await ctx.db.insert("experiments", {
        name: "legacy",
        createdAt: 1,
      });
      const legacyRun = await ctx.db.insert("runs", {
        experimentId: legacyExp,
        status: "finished",
        startedAt: 1,
      });
      return { legacyExp, legacyRun };
    });

    const asAlice = t.withIdentity(alice);
    await asAlice.mutation(api.organizations.create, { name: "Lab" });

    // Not "readable by any authenticated user" — not readable at all.
    expect(await asAlice.query(api.experiments.get, { id: legacyExp })).toBeNull();
    const orgless = /has no organization/;
    await expect(
      asAlice.query(api.runs.get, { runId: legacyRun }),
    ).rejects.toThrow(orgless);
    await expect(
      asAlice.query(api.artifacts.listForRun, { runId: legacyRun }),
    ).rejects.toThrow(orgless);
    await expect(
      asAlice.query(api.logs.listForRun, { runId: legacyRun }),
    ).rejects.toThrow(orgless);
    await expect(
      asAlice.mutation(api.runs.setNotes, { runId: legacyRun, notes: "x" }),
    ).rejects.toThrow(orgless);
    await expect(
      asAlice.mutation(api.experiments.remove, { experimentId: legacyExp }),
    ).rejects.toThrow(orgless);
  });

  test("unauthenticated callers get nothing at all", async () => {
    const { t, runA, expA, orgA } = await twoTenants();
    const anon = /not authenticated/;
    await expect(t.query(api.runs.get, { runId: runA })).rejects.toThrow(anon);
    await expect(
      t.query(api.experiments.list, { organizationId: orgA }),
    ).rejects.toThrow(anon);
    await expect(
      t.query(api.artifacts.listForRun, { runId: runA }),
    ).rejects.toThrow(anon);
    await expect(
      t.mutation(api.runs.create, { experimentId: expA }),
    ).rejects.toThrow(anon);
    await expect(
      t.mutation(api.organizations.create, { name: "x" }),
    ).rejects.toThrow(anon);
    // The "who am I" queries are the deliberate exceptions: they answer
    // "nobody" instead of throwing, because the UI polls them before a
    // session exists.
    expect(await t.query(api.organizations.myOrgs, {})).toEqual([]);
    expect(await t.query(api.users.me, {})).toBeNull();
    expect(
      await t.query(api.organizations.myRole, { organizationId: orgA }),
    ).toBeNull();
    expect(await t.query(api.cliLinks.listMine, {})).toEqual([]);
  });
});
