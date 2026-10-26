import { v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  ORG_ROLE,
  QUEUED_JOB_STATE,
  queueScheduler,
  queuedJobState,
  type QueuedJobState,
} from "./schema";
import {
  authEnabled,
  authorizeExperimentWrite,
  gateExperimentRead,
  orgOfExperiment,
  requireOrgRole,
  resolveOrgScope,
} from "./authz";

// Scheduler-queue visibility (roadmap P1-2).
//
// The architecture constraint that shapes this module: the backend can NEVER
// reach the cluster. Only the wrapper on a login node can run squeue/scancel.
// So the division of labour is strict:
//
//   - the wrapper REPORTS (register on submit, updateStates from the
//     `dftstream queue` watcher) and EXECUTES (scancel);
//   - the backend STORES queue state;
//   - the UI DISPLAYS it and REQUESTS cancellation (requestCancel sets a
//     flag; the watcher acts on it at its next poll).

// States a job can still leave on its own. Everything else is terminal.
const ACTIVE_STATES: QueuedJobState[] = [
  QUEUED_JOB_STATE.PENDING,
  QUEUED_JOB_STATE.RUNNING,
  QUEUED_JOB_STATE.UNKNOWN,
];

export function isTerminalQueueState(state: QueuedJobState): boolean {
  return !ACTIVE_STATES.includes(state);
}

// Largest updateStates batch. The watcher polls a login node's worth of jobs,
// not the world; a larger batch is a bug, not a workload.
const MAX_STATE_UPDATES = 256;

// listByExperiment page size. Queue rows are transient (jobs either link to a
// run or reach a terminal state), so a bounded newest-first take is honest.
const LIST_TAKE = 200;

async function gateQueuedJobWrite(
  ctx: QueryCtx,
  job: Doc<"queuedJobs">,
): Promise<void> {
  if (!authEnabled()) return;
  // Same bar as writing a run (gateRunWrite): member+ in the owning org.
  // Viewers can look at the queue but cannot cancel or rewrite it.
  await requireOrgRole(
    ctx,
    await orgOfExperiment(ctx, job.experimentId),
    ORG_ROLE.MEMBER,
  );
}

// register records one submitted job. Called by the wrapper right after a
// successful sbatch — best-effort on the wrapper side, so this must be
// idempotent: re-registering the same (cluster, schedulerJobId) while the
// existing row is still active returns that row instead of duplicating it.
export const register = mutation({
  args: {
    experimentId: v.id("experiments"),
    cluster: v.string(),
    scheduler: queueScheduler,
    schedulerJobId: v.string(),
    inputBasename: v.string(),
    arraySpec: v.optional(v.string()),
    taskCount: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const writer = await authorizeExperimentWrite(ctx, args.experimentId);
    let organizationId = writer?.orgId;
    if (!writer) {
      // Auth off: still denormalize the org when the experiment has one so
      // flipping enforcement on later does not orphan existing rows.
      const exp = await ctx.db.get(args.experimentId);
      if (!exp) throw new Error("experiment not found");
      organizationId = exp.organizationId;
    }
    if (args.schedulerJobId.trim() === "") {
      throw new Error("schedulerJobId cannot be empty");
    }
    const existing = await ctx.db
      .query("queuedJobs")
      .withIndex("by_scheduler_job", (q) =>
        q.eq("schedulerJobId", args.schedulerJobId),
      )
      .collect();
    for (const row of existing) {
      if (
        row.cluster === args.cluster &&
        row.experimentId === args.experimentId &&
        !isTerminalQueueState(row.state)
      ) {
        return row._id;
      }
    }
    const now = Date.now();
    return await ctx.db.insert("queuedJobs", {
      ...args,
      organizationId,
      submittedByUserId: writer?.userId,
      state: QUEUED_JOB_STATE.PENDING,
      submittedAt: now,
      updatedAt: now,
    });
  },
});

// applyState enforces the transition rule shared by updateStates and the
// cancel path: a terminal state is sticky against the ACTIVE states (a stale
// or out-of-order poll must not resurrect a finished job), but may be
// corrected to another terminal state (sacct refining "failed" into
// "cancelled" once the reason field lands). Returns whether it wrote.
async function applyState(
  ctx: MutationCtx,
  job: Doc<"queuedJobs">,
  state: QueuedJobState,
): Promise<boolean> {
  if (isTerminalQueueState(job.state) && !isTerminalQueueState(state)) {
    return false;
  }
  if (job.state === state) return false;
  await ctx.db.patch(job._id, { state, updatedAt: Date.now() });
  return true;
}

// updateStates is the watcher's batched report of what squeue/sacct said.
// Regressions out of a terminal state are SKIPPED, not errored: the watcher
// may race another watcher or replay a stale poll, and failing the whole
// batch over one stale item would stall every other update in it. The
// per-item result says what happened so the CLI can log skips.
export const updateStates = mutation({
  args: {
    items: v.array(
      v.object({ id: v.id("queuedJobs"), state: queuedJobState }),
    ),
  },
  handler: async (ctx, { items }) => {
    if (items.length > MAX_STATE_UPDATES) {
      throw new Error(`too many state updates in one batch (max ${MAX_STATE_UPDATES})`);
    }
    const results: { id: Id<"queuedJobs">; applied: boolean }[] = [];
    for (const item of items) {
      const job = await ctx.db.get(item.id);
      if (!job) throw new Error("queued job not found");
      await gateQueuedJobWrite(ctx, job);
      results.push({ id: item.id, applied: await applyState(ctx, job, item.state) });
    }
    return results;
  },
});

// requestCancel flags a job for cancellation. It does NOT cancel anything —
// the backend has no route to the cluster. The login-node watcher
// (`dftstream queue watch`) sees the flag at its next poll and runs scancel.
// Member+ required, mirroring run writes: viewers cannot cancel jobs.
export const requestCancel = mutation({
  args: { id: v.id("queuedJobs") },
  handler: async (ctx, { id }) => {
    const job = await ctx.db.get(id);
    if (!job) throw new Error("queued job not found");
    await gateQueuedJobWrite(ctx, job);
    if (isTerminalQueueState(job.state)) {
      throw new Error(`job is already ${job.state}; nothing to cancel`);
    }
    if (job.cancelRequested) return; // idempotent
    await ctx.db.patch(id, {
      cancelRequested: true,
      cancelRequestedAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

// listByExperiment feeds the experiment view's queue section, newest first.
export const listByExperiment = query({
  args: { experimentId: v.id("experiments") },
  handler: async (ctx, { experimentId }) => {
    await gateExperimentRead(ctx, experimentId);
    return await ctx.db
      .query("queuedJobs")
      .withIndex("by_experiment", (q) => q.eq("experimentId", experimentId))
      .order("desc")
      .take(LIST_TAKE);
  },
});

// listActive is the watcher's worklist: every job that may still change
// state (plus its cancelRequested flag), org-scoped when auth is on —
// mirrors runs.listRunning's shape. `cluster` narrows to the cluster the
// watcher can actually see from its login node.
export const listActive = query({
  args: {
    organizationId: v.optional(v.id("organizations")),
    cluster: v.optional(v.string()),
  },
  handler: async (ctx, { organizationId, cluster }) => {
    const scope = await resolveOrgScope(ctx, organizationId);
    const out: Doc<"queuedJobs">[] = [];
    for (const state of ACTIVE_STATES) {
      out.push(
        ...(scope === null
          ? await ctx.db
              .query("queuedJobs")
              .withIndex("by_state", (q) => q.eq("state", state))
              .collect()
          : await ctx.db
              .query("queuedJobs")
              .withIndex("by_org_state", (q) =>
                q.eq("organizationId", scope).eq("state", state),
              )
              .collect()),
      );
    }
    return cluster === undefined ? out : out.filter((r) => r.cluster === cluster);
  },
});

// autoLinkQueuedJob ties a queued job to the tracked run that started under
// it, matching on the scheduler job id the run reports. Called from
// runs.insertRun IN THE SAME transaction as the run insert. Not a registered
// entry point — plain function, no own gate (the caller has already
// authorized the run write; the same-experiment rule below is what keeps a
// forged or recycled schedulerJobId from linking across tenants).
export async function autoLinkQueuedJob(
  ctx: MutationCtx,
  runId: Id<"runs">,
  experimentId: Id<"experiments">,
  schedulerJobId: string,
): Promise<void> {
  // A run whose experiment is gone has nothing to link into. insertRun has
  // just written a run under this id, so this is belt-and-braces — but it
  // belongs before the candidate reads, not inside the loop over them.
  if ((await ctx.db.get(experimentId)) === null) return;
  // Array tasks report "<base>_<task>"; the registered row holds the base id.
  const baseId = schedulerJobId.split("_")[0] ?? schedulerJobId;
  const candidates = [
    ...(await ctx.db
      .query("queuedJobs")
      .withIndex("by_scheduler_job", (q) => q.eq("schedulerJobId", schedulerJobId))
      .collect()),
    ...(baseId !== schedulerJobId
      ? await ctx.db
          .query("queuedJobs")
          .withIndex("by_scheduler_job", (q) => q.eq("schedulerJobId", baseId))
          .collect()
      : []),
  ];
  for (const job of candidates) {
    // Same experiment only (which implies same org): scheduler ids recycle
    // across clusters and tenants, so anything looser links strangers.
    if (job.experimentId !== experimentId) continue;
    if (job.linkedRunId !== undefined) continue;
    // Array jobs fan out into many runs; a single linkedRunId would be a lie.
    if (job.arraySpec !== undefined) continue;
    await ctx.db.patch(job._id, {
      linkedRunId: runId,
      // ORCA is running under the job, so the queue row is at least RUNNING;
      // don't regress a terminal state (out-of-order sync replay).
      ...(isTerminalQueueState(job.state)
        ? {}
        : { state: QUEUED_JOB_STATE.RUNNING }),
      updatedAt: Date.now(),
    });
    return;
  }
}
