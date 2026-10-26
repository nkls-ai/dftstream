/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema, { QUEUED_JOB_STATE } from "./schema";

// Behavioural tests for the scheduler-queue module (queue.ts). The suite runs
// with DFTSTREAM_AUTH_REQUIRED=1 (vitest.config.ts), so every gate is live.

const modules = import.meta.glob("./**/*.ts");

const alice = { subject: "alice", issuer: "test", email: "alice@lab.edu" };
const bob = { subject: "bob", issuer: "test", email: "bob@lab.edu" };
const carol = { subject: "carol", issuer: "test", email: "carol@lab.edu" };

function setup() {
  return convexTest(schema, modules);
}

// Two tenants: Alice owns org A with one experiment and one registered job;
// Bob owns org B. Carol exists to be granted roles in org A.
async function fixture() {
  const t = setup();
  const asAlice = t.withIdentity(alice);
  const asBob = t.withIdentity(bob);
  const asCarol = t.withIdentity(carol);

  const orgA = (
    await asAlice.mutation(api.organizations.create, { name: "Lab A" })
  ).organizationId;
  const orgB = (await asBob.mutation(api.organizations.create, { name: "Lab B" }))
    .organizationId;
  const expA = await asAlice.mutation(api.experiments.ensure, {
    name: "exp-a",
    organizationId: orgA,
  });
  const jobA = await asAlice.mutation(api.queue.register, {
    experimentId: expA,
    cluster: "hpc1",
    scheduler: "slurm",
    schedulerJobId: "4242",
    inputBasename: "opt-freq_x.inp",
  });
  return { t, asAlice, asBob, asCarol, orgA, orgB, expA, jobA };
}

describe("queue register", () => {
  test("registers pending and is idempotent per cluster+job id while active", async () => {
    const { asAlice, expA, jobA } = await fixture();
    const jobs = await asAlice.query(api.queue.listByExperiment, {
      experimentId: expA,
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.state).toBe(QUEUED_JOB_STATE.PENDING);
    expect(jobs[0]!.submittedByUserId).toBeDefined();

    // Same cluster + scheduler id re-registered → same row.
    const again = await asAlice.mutation(api.queue.register, {
      experimentId: expA,
      cluster: "hpc1",
      scheduler: "slurm",
      schedulerJobId: "4242",
      inputBasename: "opt-freq_x.inp",
    });
    expect(again).toBe(jobA);

    // A different cluster recycling the same numeric id is a NEW job.
    const other = await asAlice.mutation(api.queue.register, {
      experimentId: expA,
      cluster: "hpc2",
      scheduler: "slurm",
      schedulerJobId: "4242",
      inputBasename: "sp_y.inp",
    });
    expect(other).not.toBe(jobA);
  });

  test("cross-org registration is refused", async () => {
    const { asBob, expA } = await fixture();
    await expect(
      asBob.mutation(api.queue.register, {
        experimentId: expA,
        cluster: "hpc1",
        scheduler: "slurm",
        schedulerJobId: "7",
        inputBasename: "x.inp",
      }),
    ).rejects.toThrow(/not a member/);
  });
});

describe("queue state transitions", () => {
  test("active states move freely; terminal states are sticky against regression", async () => {
    const { asAlice, jobA, expA } = await fixture();
    const step = async (state: string) =>
      (
        await asAlice.mutation(api.queue.updateStates, {
          items: [{ id: jobA, state: state as never }],
        })
      )[0]!;

    expect((await step(QUEUED_JOB_STATE.RUNNING)).applied).toBe(true);
    expect((await step(QUEUED_JOB_STATE.COMPLETED)).applied).toBe(true);
    // Stale poll trying to resurrect a finished job is skipped, not an error.
    expect((await step(QUEUED_JOB_STATE.RUNNING)).applied).toBe(false);
    expect((await step(QUEUED_JOB_STATE.PENDING)).applied).toBe(false);
    // Terminal → terminal correction (sacct refining the reason) is allowed.
    expect((await step(QUEUED_JOB_STATE.FAILED)).applied).toBe(true);

    const jobs = await asAlice.query(api.queue.listByExperiment, {
      experimentId: expA,
    });
    expect(jobs[0]!.state).toBe(QUEUED_JOB_STATE.FAILED);
  });

  test("cross-org updateStates is refused", async () => {
    const { asBob, jobA } = await fixture();
    await expect(
      asBob.mutation(api.queue.updateStates, {
        items: [{ id: jobA, state: QUEUED_JOB_STATE.RUNNING }],
      }),
    ).rejects.toThrow(/not a member/);
  });
});

describe("queue requestCancel", () => {
  test("member sets the flag; watcher list surfaces it; idempotent", async () => {
    const { asAlice, jobA, orgA } = await fixture();
    await asAlice.mutation(api.queue.requestCancel, { id: jobA });
    await asAlice.mutation(api.queue.requestCancel, { id: jobA }); // no throw
    const active = await asAlice.query(api.queue.listActive, {
      organizationId: orgA,
      cluster: "hpc1",
    });
    expect(active).toHaveLength(1);
    expect(active[0]!.cancelRequested).toBe(true);
  });

  test("viewer cannot cancel; member can", async () => {
    const { t, asAlice, asCarol, orgA, jobA } = await fixture();
    const asBobViewer = t.withIdentity(bob);
    await asBobViewer.mutation(api.users.ensureSelf, {});
    await asCarol.mutation(api.users.ensureSelf, {});
    await asAlice.mutation(api.organizations.addMember, {
      organizationId: orgA,
      email: "bob@lab.edu",
      role: "viewer",
    });
    await asAlice.mutation(api.organizations.addMember, {
      organizationId: orgA,
      email: "carol@lab.edu",
      role: "member",
    });
    await expect(
      asBobViewer.mutation(api.queue.requestCancel, { id: jobA }),
    ).rejects.toThrow(/insufficient permission/);
    await asCarol.mutation(api.queue.requestCancel, { id: jobA });
  });

  test("cancelling a finished job is an explicit error", async () => {
    const { asAlice, jobA } = await fixture();
    await asAlice.mutation(api.queue.updateStates, {
      items: [{ id: jobA, state: QUEUED_JOB_STATE.COMPLETED }],
    });
    await expect(
      asAlice.mutation(api.queue.requestCancel, { id: jobA }),
    ).rejects.toThrow(/already completed/);
  });

  test("cross-org cancel is refused", async () => {
    const { asBob, jobA } = await fixture();
    await expect(
      asBob.mutation(api.queue.requestCancel, { id: jobA }),
    ).rejects.toThrow(/not a member/);
  });
});

describe("queue listActive", () => {
  test("requires an organization and membership under auth", async () => {
    const { asAlice, asBob, orgA } = await fixture();
    await expect(asAlice.query(api.queue.listActive, {})).rejects.toThrow(
      /organization required/,
    );
    await expect(
      asBob.query(api.queue.listActive, { organizationId: orgA }),
    ).rejects.toThrow(/not a member/);
  });

  test("terminal jobs leave the watcher's worklist", async () => {
    const { asAlice, jobA, orgA } = await fixture();
    await asAlice.mutation(api.queue.updateStates, {
      items: [{ id: jobA, state: QUEUED_JOB_STATE.CANCELLED }],
    });
    expect(
      await asAlice.query(api.queue.listActive, { organizationId: orgA }),
    ).toEqual([]);
  });
});

describe("queue ↔ run linking", () => {
  test("runs.create with a matching schedulerJobId auto-links and marks running", async () => {
    const { asAlice, expA, jobA } = await fixture();
    const runId = await asAlice.mutation(api.runs.create, {
      experimentId: expA,
      schedulerJobId: "4242",
    });
    const jobs = await asAlice.query(api.queue.listByExperiment, {
      experimentId: expA,
    });
    const job = jobs.find((j) => j._id === jobA)!;
    expect(job.linkedRunId).toBe(runId);
    expect(job.state).toBe(QUEUED_JOB_STATE.RUNNING);
  });

  test("array-task ids link to the base job only when it is not an array registration", async () => {
    const { asAlice, expA } = await fixture();
    const arrayJob = await asAlice.mutation(api.queue.register, {
      experimentId: expA,
      cluster: "hpc1",
      scheduler: "slurm",
      schedulerJobId: "9000",
      inputBasename: "batch",
      arraySpec: "1-4%2",
      taskCount: 4,
    });
    await asAlice.mutation(api.runs.create, {
      experimentId: expA,
      schedulerJobId: "9000_2",
    });
    const jobs = await asAlice.query(api.queue.listByExperiment, {
      experimentId: expA,
    });
    // An array job fans out into many runs; a single linkedRunId would lie.
    expect(jobs.find((j) => j._id === arrayJob)!.linkedRunId).toBeUndefined();
  });

  test("a schedulerJobId from another experiment does not link", async () => {
    const { asAlice, asBob, expA, jobA, orgB } = await fixture();
    const expB = await asBob.mutation(api.experiments.ensure, {
      name: "exp-b",
      organizationId: orgB,
    });
    await asBob.mutation(api.runs.create, {
      experimentId: expB,
      schedulerJobId: "4242",
    });
    const jobs = await asAlice.query(api.queue.listByExperiment, {
      experimentId: expA,
    });
    expect(jobs.find((j) => j._id === jobA)!.linkedRunId).toBeUndefined();
  });
});
