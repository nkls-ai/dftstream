/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

// Behavioural coverage for the org template library (db/convex/templates.ts):
// tenancy (a template belongs to one org and is invisible to another), the
// "members delete own" rule the rest of the codebase uses, the payload caps,
// and the local single-user path — the public build runs these same functions
// with auth off and must still work. The static gate check lives in
// authzCoverage.test.ts.
//
// The suite runs with DFTSTREAM_AUTH_REQUIRED=1 (vitest.config.ts), so the
// local-mode tests stub it off explicitly.

const alice = { subject: "alice", issuer: "test", email: "alice@lab.edu" };
const bob = { subject: "bob", issuer: "test", email: "bob@lab.edu" };

const STATE = JSON.stringify({ version: 1, state: { job: "opt-freq", presetId: "r2scan-3c" } });

function payload(over: Partial<{ name: string; description: string; state: string; stateVersion: number }> = {}) {
  return {
    name: "Solvated Opt+Freq",
    description: "opt-freq · r2scan-3c · cpcm(Water)",
    state: STATE,
    stateVersion: 1,
    ...over,
  };
}

async function fixture() {
  const t = convexTest(schema, modules);
  const asAlice = t.withIdentity(alice);
  const asBob = t.withIdentity(bob);
  const orgA = (await asAlice.mutation(api.organizations.create, { name: "Lab A" })).organizationId;
  const orgB = (await asBob.mutation(api.organizations.create, { name: "Lab B" })).organizationId;
  return { t, asAlice, asBob, orgA, orgB };
}

describe("templates with auth on", () => {
  test("a template is created, listed and updated inside its own org", async () => {
    const { asAlice, orgA } = await fixture();
    const id = await asAlice.mutation(api.templates.create, { ...payload(), organizationId: orgA });

    const listed = await asAlice.query(api.templates.list, { organizationId: orgA });
    expect(listed.map((r) => r.name)).toEqual(["Solvated Opt+Freq"]);
    expect(listed[0]!.state).toBe(STATE);
    expect(listed[0]!.stateVersion).toBe(1);

    await asAlice.mutation(api.templates.update, {
      templateId: id,
      ...payload({ name: "Solvated Opt+Freq (tight)", state: JSON.stringify({ version: 1, state: {} }) }),
    });
    const [got] = await asAlice.query(api.templates.list, { organizationId: orgA });
    expect(got?._id).toBe(id);
    expect(got?.name).toBe("Solvated Opt+Freq (tight)");
    expect(got!.updatedAt).toBeGreaterThanOrEqual(got!.createdAt);
  });

  test("another org can neither read nor write it", async () => {
    const { asAlice, asBob, orgA } = await fixture();
    const id = await asAlice.mutation(api.templates.create, { ...payload(), organizationId: orgA });

    await expect(asBob.query(api.templates.list, { organizationId: orgA })).rejects.toThrow(/not a member/);
    await expect(
      asBob.mutation(api.templates.update, { templateId: id, ...payload({ name: "mine now" }) }),
    ).rejects.toThrow(/not a member/);
    await expect(asBob.mutation(api.templates.remove, { templateId: id })).rejects.toThrow(/not a member/);

    // And Bob's own org sees nothing of Alice's.
    const { organizationId: orgB } = (await asBob.query(api.organizations.myOrgs))[0]!;
    expect(await asBob.query(api.templates.list, { organizationId: orgB })).toEqual([]);
  });

  test("a viewer cannot create one, and a member cannot delete a colleague's", async () => {
    const { asAlice, asBob, orgA } = await fixture();
    // Bob signs in once so his identity row exists, then joins as viewer.
    await asBob.mutation(api.users.ensureSelf);
    await asAlice.mutation(api.organizations.addMember, {
      organizationId: orgA,
      email: "bob@lab.edu",
      role: "viewer",
    });

    await expect(
      asBob.mutation(api.templates.create, { ...payload(), organizationId: orgA }),
    ).rejects.toThrow(/insufficient permission/);

    const id = await asAlice.mutation(api.templates.create, { ...payload(), organizationId: orgA });
    await asAlice.mutation(api.organizations.updateRole, {
      membershipId: (await asAlice.query(api.organizations.members, { organizationId: orgA })).find(
        (m) => m.email === "bob@lab.edu",
      )!.membershipId,
      role: "member",
    });
    // A member may delete their own; this one is Alice's.
    await expect(asBob.mutation(api.templates.remove, { templateId: id })).rejects.toThrow(
      /insufficient permission/,
    );
    await asAlice.mutation(api.templates.remove, { templateId: id });
    expect(await asAlice.query(api.templates.list, { organizationId: orgA })).toEqual([]);
  });

  test("an unnamed template, or one carrying a molecule, is refused", async () => {
    const { asAlice, orgA } = await fixture();
    await expect(
      asAlice.mutation(api.templates.create, { ...payload({ name: "   " }), organizationId: orgA }),
    ).rejects.toThrow(/cannot be empty/);

    // A template is a recipe; a payload this size means a structure (or a
    // whole trajectory) is being smuggled into the library.
    await expect(
      asAlice.mutation(api.templates.create, {
        ...payload({ state: "x".repeat(64 * 1024 + 1) }),
        organizationId: orgA,
      }),
    ).rejects.toThrow(/over the .* limit/);

    await expect(
      asAlice.mutation(api.templates.create, {
        ...payload({ description: "d".repeat(2001) }),
        organizationId: orgA,
      }),
    ).rejects.toThrow(/over 2000 characters/);
  });

  test("an org is required when auth is on", async () => {
    const { asAlice } = await fixture();
    await expect(asAlice.mutation(api.templates.create, payload())).rejects.toThrow(
      /organization required/,
    );
    await expect(asAlice.query(api.templates.list, {})).rejects.toThrow(/organization required/);
  });
});

describe("templates in local single-user mode", () => {
  test("the same functions work with no identity and no org", async () => {
    // The public build ships exactly this path: auth off, implicit org.
    vi.stubEnv("DFTSTREAM_AUTH_REQUIRED", "0");
    const t = convexTest(schema, modules);

    const id = await t.mutation(api.templates.create, payload());
    expect((await t.query(api.templates.list, {})).map((r) => r.name)).toEqual(["Solvated Opt+Freq"]);
    expect((await t.query(api.templates.list, {}))[0]?.state).toBe(STATE);

    await t.mutation(api.templates.update, { templateId: id, ...payload({ name: "renamed" }) });
    expect((await t.query(api.templates.list, {}))[0]?.name).toBe("renamed");

    await t.mutation(api.templates.remove, { templateId: id });
    expect(await t.query(api.templates.list, {})).toEqual([]);
    // Removing what is already gone is a no-op, not an error.
    await t.mutation(api.templates.remove, { templateId: id });
  });

  test("local rows become invisible once auth is turned on", async () => {
    // An org-less row is a pre-auth leftover: every org gate must treat it
    // as not-found rather than hand it to an authenticated caller.
    vi.stubEnv("DFTSTREAM_AUTH_REQUIRED", "0");
    const t = convexTest(schema, modules);
    const id = await t.mutation(api.templates.create, payload());

    vi.stubEnv("DFTSTREAM_AUTH_REQUIRED", "1");
    const asAlice = t.withIdentity(alice);
    const orgA = (await asAlice.mutation(api.organizations.create, { name: "Lab A" })).organizationId;
    expect(await asAlice.query(api.templates.list, { organizationId: orgA })).toEqual([]);
    await expect(
      asAlice.mutation(api.templates.update, { templateId: id, ...payload() }),
    ).rejects.toThrow(/not found/);
  });
});
