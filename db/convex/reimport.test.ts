/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

// Behavioural coverage for the reimport backend (db/convex/reimport.ts):
// gating (same tenancy rules as the runs.ts writes it mirrors), the field
// whitelist (user data and execution facts are unreachable), the null→clear
// semantics, and findOutput's kind preference. The static gate check lives in
// authzCoverage.test.ts.

const alice = { subject: "alice", issuer: "test", email: "alice@lab.edu" };
const bob = { subject: "bob", issuer: "test", email: "bob@lab.edu" };

function setup() {
  return convexTest(schema, modules);
}

// One tenant with a finished run carrying the historical bad verdict
// (converged=true on a stalled opt) plus stale thermo, and a second tenant
// with no access to it.
async function fixture() {
  const t = setup();
  const asAlice = t.withIdentity(alice);
  const asBob = t.withIdentity(bob);

  const orgA = (
    await asAlice.mutation(api.organizations.create, { name: "Lab A" })
  ).organizationId;
  await asBob.mutation(api.organizations.create, { name: "Lab B" });

  const expA = await asAlice.mutation(api.experiments.ensure, {
    name: "exp-a",
    organizationId: orgA,
  });
  const runA = await asAlice.mutation(api.runs.create, {
    experimentId: expA,
    name: "opt-1",
    inputText: "! r2SCAN-3c Opt\n",
  });
  await asAlice.mutation(api.runs.updateStatus, {
    runId: runA,
    status: "finished",
    exitCode: 0,
    converged: true, // the historical bug: stalled opt stored as converged
    gibbsEh: -75.9, // stale pre-convergence thermo the new parser gates out
    lastEnergy: -75.955,
  });
  await asAlice.mutation(api.runs.setNotes, { runId: runA, notes: "keep me" });
  return { t, asAlice, asBob, orgA, expA, runA };
}

describe("reimport.apply", () => {
  test("patches parser-derived fields, clears on null, stamps bookkeeping", async () => {
    const { t, asAlice, runA } = await fixture();
    await asAlice.mutation(api.reimport.apply, {
      runId: runA,
      reimportedWith: "v9.9.9-test",
      converged: false,
      optMaxCycles: true,
      errorClass: "opt_max_cycles",
      gibbsEh: null, // current parser: thermo belonged to a pre-conv hessian
    });
    const run = await t.run(async (ctx) => await ctx.db.get(runA));
    expect(run).toMatchObject({
      converged: false,
      optMaxCycles: true,
      errorClass: "opt_max_cycles",
      reimportedWith: "v9.9.9-test",
    });
    expect(run!.gibbsEh).toBeUndefined(); // null cleared the field
    expect(run!.reimportedAt).toBeTypeOf("number");
    // Untouched: user data, execution facts, measurements not in the patch.
    expect(run!.notes).toBe("keep me");
    expect(run!.status).toBe("finished");
    expect(run!.exitCode).toBe(0);
    expect(run!.lastEnergy).toBe(-75.955);
  });

  test("absent fields leave stored values untouched (idempotent no-op patch)", async () => {
    const { t, asAlice, runA } = await fixture();
    await asAlice.mutation(api.reimport.apply, {
      runId: runA,
      reimportedWith: "v9.9.9-test",
    });
    const run = await t.run(async (ctx) => await ctx.db.get(runA));
    expect(run!.converged).toBe(true);
    expect(run!.gibbsEh).toBe(-75.9);
  });

  test("the whitelist rejects user data and execution facts", async () => {
    const { asAlice, runA } = await fixture();
    // The validator IS the whitelist: extra keys fail arg validation.
    for (const forbidden of [
      { notes: "overwritten" },
      { status: "failed" },
      { exitCode: 137 },
      { name: "renamed" },
      { tags: ["x"] },
    ]) {
      await expect(
        asAlice.mutation(api.reimport.apply, {
          runId: runA,
          reimportedWith: "v9.9.9-test",
          ...forbidden,
        } as never),
      ).rejects.toThrow(/Validator error|extra field|Unexpected/i);
    }
  });

  test("non-members cannot apply (same gate as runs.updateStatus)", async () => {
    const { asBob, runA } = await fixture();
    await expect(
      asBob.mutation(api.reimport.apply, {
        runId: runA,
        reimportedWith: "v9.9.9-test",
        converged: false,
      }),
    ).rejects.toThrow(/not a member/);
  });

  test("refuses non-terminal runs", async () => {
    const { asAlice, expA } = await fixture();
    const pending = await asAlice.mutation(api.runs.create, {
      experimentId: expA,
      name: "still-running",
    });
    await expect(
      asAlice.mutation(api.reimport.apply, {
        runId: pending,
        reimportedWith: "v9.9.9-test",
        converged: true,
      }),
    ).rejects.toThrow(/finished or failed/);
  });
});

describe("reimport.listRuns / findOutput", () => {
  test("listRuns pages in stable startedAt order and is read-gated", async () => {
    const { asAlice, asBob, expA } = await fixture();
    const page = await asAlice.query(api.reimport.listRuns, {
      experimentId: expA,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(page.page.map((r) => r.name)).toEqual(["opt-1"]);
    // Projection carries what the recompute needs, not the whole row.
    expect(page.page[0]).toHaveProperty("inputText");
    expect(page.page[0]).not.toHaveProperty("notes");
    await expect(
      asBob.query(api.reimport.listRuns, {
        experimentId: expA,
        paginationOpts: { numItems: 10, cursor: null },
      }),
    ).rejects.toThrow(/not a member/);
  });

  test("findOutput prefers the output artifact over stdout, null when neither", async () => {
    const { asAlice, asBob, runA } = await fixture();
    expect(
      await asAlice.query(api.reimport.findOutput, { runId: runA }),
    ).toBeNull();
    await asAlice.mutation(api.artifacts.appendToRun, {
      runId: runA,
      items: [
        {
          name: "job.stdout.out",
          path: "/host/job.stdout.out",
          kind: "stdout",
          sizeBytes: 10,
          mtime: 1,
          contentText: "stdout capture",
        },
        {
          name: "job.out",
          path: "/host/job.out",
          kind: "output",
          sizeBytes: 20,
          mtime: 1,
          contentText: "the real .out",
        },
      ],
    });
    const found = await asAlice.query(api.reimport.findOutput, { runId: runA });
    expect(found).toMatchObject({ name: "job.out", kind: "output" });
    await expect(
      asBob.query(api.reimport.findOutput, { runId: runA }),
    ).rejects.toThrow(/not a member/);
  });
});
