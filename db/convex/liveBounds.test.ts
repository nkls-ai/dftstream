/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema, { RUN_STATUS } from "./schema";

const modules = import.meta.glob("./**/*.ts");

// Bounds on the live subscriptions that used to read (and return) without
// limit: the running-run set behind the notification bell, and a run's
// optimization trajectory.

afterEach(() => {
  vi.unstubAllEnvs();
});

const alice = { subject: "alice", issuer: "test", email: "alice@lab.edu" };
const bob = { subject: "bob", issuer: "test", email: "bob@lab.edu" };
const INPUT = "! B3LYP def2-SVP Opt\n*xyz 0 1\nH 0 0 0\n*\n";

describe("runs.listRunning", () => {
  test("never ships inputText, and stays org-scoped", async () => {
    const t = convexTest(schema, modules);
    const asAlice = t.withIdentity(alice);
    const asBob = t.withIdentity(bob);
    const orgA = (await asAlice.mutation(api.organizations.create, { name: "A" }))
      .organizationId;
    const orgB = (await asBob.mutation(api.organizations.create, { name: "B" }))
      .organizationId;
    const expA = await asAlice.mutation(api.experiments.ensure, {
      name: "a",
      organizationId: orgA,
    });
    const expB = await asBob.mutation(api.experiments.ensure, {
      name: "b",
      organizationId: orgB,
    });
    for (const [as, exp] of [
      [asAlice, expA],
      [asBob, expB],
    ] as const) {
      const runId = await as.mutation(api.runs.create, {
        experimentId: exp,
        inputText: INPUT,
      });
      await as.mutation(api.runs.updateStatus, {
        runId,
        status: RUN_STATUS.RUNNING,
      });
    }

    const running = await asAlice.query(api.runs.listRunning, {
      organizationId: orgA,
    });
    expect(running).toHaveLength(1);
    expect(running[0]!.experimentId).toBe(expA);
    expect("inputText" in running[0]!).toBe(false);
    await expect(
      asAlice.query(api.runs.listRunning, { organizationId: orgB }),
    ).rejects.toThrow(/not a member/);
  });

  test("local mode lists every running run, without inputText", async () => {
    vi.stubEnv("DFTSTREAM_AUTH_REQUIRED", "0");
    const t = convexTest(schema, modules);
    const exp = await t.mutation(api.experiments.ensure, { name: "local" });
    const runId = await t.mutation(api.runs.create, {
      experimentId: exp,
      inputText: INPUT,
    });
    await t.mutation(api.runs.updateStatus, { runId, status: RUN_STATUS.RUNNING });
    const running = await t.query(api.runs.listRunning, {});
    expect(running.map((r) => r._id)).toEqual([runId]);
    expect(JSON.stringify(running)).not.toContain("B3LYP");
  });
});

describe("geometries.listForRun", () => {
  async function runWithCycles(n: number, xyz: (cycle: number) => string) {
    vi.stubEnv("DFTSTREAM_AUTH_REQUIRED", "0");
    const t = convexTest(schema, modules);
    const exp = await t.mutation(api.experiments.ensure, { name: "traj" });
    const runId = await t.mutation(api.runs.create, { experimentId: exp });
    await t.run(async (ctx) => {
      for (let cycle = 0; cycle < n; cycle++) {
        await ctx.db.insert("geometries", { runId, cycle, xyz: xyz(cycle), ts: cycle });
      }
    });
    return { t, runId };
  }

  test("a short trajectory comes back whole, in cycle order", async () => {
    const { t, runId } = await runWithCycles(5, () => "H 0 0 0");
    const rows = await t.query(api.geometries.listForRun, { runId });
    expect(rows.map((r) => r.cycle)).toEqual([0, 1, 2, 3, 4]);
  });

  test("a long trajectory keeps the start and a contiguous newest tail", async () => {
    const { t, runId } = await runWithCycles(1200, () => "H 0 0 0");
    const rows = await t.query(api.geometries.listForRun, { runId });
    expect(rows).toHaveLength(1000);
    const cycles = rows.map((r) => r.cycle);
    expect(cycles[0]).toBe(0);
    expect(cycles[cycles.length - 1]).toBe(1199);
    // Ascending, and the tail is contiguous: nothing missing near the end.
    expect(cycles.slice(1)).toEqual(
      Array.from({ length: 999 }, (_, i) => 201 + i),
    );
  });

  test("large frames are bounded by bytes, not only by count", async () => {
    // ~200 KiB per frame: 40 frames is ~8 MiB, over the return ceiling.
    const frame = "C 0.000 0.000 0.000\n".repeat(10_000);
    const { t, runId } = await runWithCycles(40, () => frame);
    const rows = await t.query(api.geometries.listForRun, { runId });
    const bytes = rows.reduce((sum, r) => sum + r.xyz.length, 0);
    expect(bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(rows[0]!.cycle).toBe(0);
    expect(rows[rows.length - 1]!.cycle).toBe(39);
  });
});
