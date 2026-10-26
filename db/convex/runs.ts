import { v, type ObjectType } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internal } from "./_generated/api";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { RUN_STATUS, runColumns, runStatus } from "./schema";
import { pick, requireNonEmptyName, stripUndefined } from "./lib/util";
import { autoLinkQueuedJob } from "./queue";
import { projectBatchRow } from "./lib/batchSummary";
import {
  compactProgress,
  readProgress,
  recordRunChange,
} from "./lib/batchProgressWriter";
import {
  authEnabled,
  authorizeExperimentWrite,
  gateExperimentRead,
  gateRunModify,
  gateRunWrite,
  resolveOrgScope,
} from "./authz";

// The wrapper-supplied subset of the runs columns. status/startedAt/
// submittedByUserId and every post-run result field are set server-side.
// Shared with spool.createRun, the journal replay's idempotent variant.
export const runCreateArgs = pick(runColumns, [
  "experimentId",
  "batchId",
  "batchParams",
  "name",
  "hostname",
  "ncores",
  "nprocs",
  "maxcoreMb",
  "orcaVersion",
  "jobType",
  "inputPath",
  "inputText",
  "cwd",
  "keywords",
  "functional",
  "basis",
  "method",
  "runTypes",
  "scfTier",
  "optTier",
  "grid",
  "solvent",
  "solventModel",
  "corrections",
  "charge",
  "mult",
  "submittedBy",
  "dftstreamVersion",
  "schedulerJobId",
  "parentRunId",
  "parentEdgeKind",
]);

export const create = mutation({
  args: runCreateArgs,
  handler: async (ctx, args) => {
    // The gate stays in the handler (not in insertRun) so the static authz
    // coverage check sees every registered entry point call it itself.
    const writer = await authorizeExperimentWrite(ctx, args.experimentId);
    return await insertRun(ctx, args, writer?.userId);
  },
});

// insertRun is runs.create's validation + insert + rollup body, factored out
// so spool.createRun (the idempotency-guarded replay path for offline
// journals) creates byte-identical rows inside its own transaction. It does
// NOT authorize: each registered entry point performs its own org gate before
// calling in (see runs.create / spool.createRun) and passes the resolved
// submitter identity down.
export async function insertRun(
  ctx: MutationCtx,
  args: ObjectType<typeof runCreateArgs>,
  submittedByUserId: Id<"appUsers"> | undefined,
): Promise<Id<"runs">> {
  {
    if (args.batchId) {
      const batch = await ctx.db.get(args.batchId);
      if (!batch) throw new Error("batch not found");
      if (batch.experimentId !== args.experimentId) {
        throw new Error("batch does not belong to experiment");
      }
    }
    // Lineage is best-effort provenance from the wrapper: a dangling or
    // cross-org parent is dropped silently rather than failing the run.
    // Orgs may be absent entirely (auth-off deployments) — compare the
    // experiments' organizationId directly, treating "none" as equal.
    if (args.parentRunId) {
      const parent = await ctx.db.get(args.parentRunId);
      const parentExp = parent && (await ctx.db.get(parent.experimentId));
      const childExp = await ctx.db.get(args.experimentId);
      const sameOrg =
        parentExp != null &&
        childExp != null &&
        (parentExp.organizationId ?? null) === (childExp.organizationId ?? null);
      if (!sameOrg) {
        delete args.parentRunId;
        delete args.parentEdgeKind;
      }
    }
    const row = {
      ...args,
      submittedByUserId,
      status: RUN_STATUS.PENDING,
      startedAt: Date.now(),
    };
    const runId = await ctx.db.insert("runs", row);
    // Same transaction as the insert: the batch rollup gains a pending run.
    await recordRunChange(ctx, null, row);
    // If the run reports the scheduler job it executes under, collapse the
    // matching queuedJobs row onto it (same experiment only; see queue.ts).
    if (args.schedulerJobId) {
      await autoLinkQueuedJob(ctx, runId, args.experimentId, args.schedulerJobId);
    }
    return runId;
  }
}

export const updateStatus = mutation({
  args: {
    runId: v.id("runs"),
    ...pick(runColumns, [
      "exitCode",
      "finishedAt",
      "lastEnergy",
      "orcaVersion",
      "nprocs",
      "wallclockSec",
      "converged",
      "optMaxCycles",
      "imaginaryModes",
      "zpeEh",
      "enthalpyEh",
      "entropyCorrEh",
      "gibbsEh",
      "gMinusEEh",
      "s2",
      "s2Ideal",
      "nebBarrierEh",
      "nebTsImageIdx",
      "ircFwdEndpointEh",
      "ircBwdEndpointEh",
      "errorClass",
      "errorExcerpt",
    ]),
    // status is required on the table but optional here: updateStatus also
    // serves partial result patches that leave the status untouched. Declared
    // after the spread so this optional validator is authoritative.
    status: v.optional(runStatus),
  },
  handler: async (ctx, { runId, ...patch }) => {
    await gateRunWrite(ctx, runId);
    const before = await ctx.db.get(runId);
    if (!before) throw new Error("run not found");
    const changes = stripUndefined(patch);
    await ctx.db.patch(runId, changes);
    // ctx.db.patch is a shallow merge, so the post-write document is exactly
    // this — no second read needed. Diffing before against after is what keeps
    // a result-only patch (no `status` key, or the same status again) from
    // double-counting: the two contributions are identical and cancel.
    await recordRunChange(ctx, before, { ...before, ...changes });
  },
});

export const listByExperiment = query({
  args: { experimentId: v.id("experiments") },
  handler: async (ctx, { experimentId }) => {
    await gateExperimentRead(ctx, experimentId);
    // Bounded: an unbounded collect() throws once an experiment accumulates
    // enough runs to blow the query limits, taking the whole run-list view
    // down with it. NOTE this array is still truncated silently — no caller
    // may derive a total from its length. The batch dashboard used to and was
    // wrong for it; it now reads batchProgress instead. The experiment-level
    // views that consume this query still need the same treatment.
    return await ctx.db
      .query("runs")
      .withIndex("by_experiment_started", (q) =>
        q.eq("experimentId", experimentId),
      )
      .order("desc")
      .take(1000);
  },
});

// listByBatchPaged replaces the old listByBatch, which ended in .take(1000)
// and handed the truncated array to the dashboard to tally client-side — a
// 2400-run batch silently reported the numbers of 1000 runs. Headline figures
// now come from batchProgress (below); this query only feeds the dense table,
// a page at a time, and returns a projection that never carries inputText (a
// whole ORCA input file per row).
export const listByBatchPaged = query({
  args: { batchId: v.id("batches"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { batchId, paginationOpts }) => {
    const batch = await ctx.db.get(batchId);
    if (!batch) throw new Error("batch not found");
    await gateExperimentRead(ctx, batch.experimentId);
    const page = await ctx.db
      .query("runs")
      .withIndex("by_batch_started", (q) => q.eq("batchId", batchId))
      .order("desc")
      .paginate(paginationOpts);
    return { ...page, page: page.page.map(projectBatchRow) };
  },
});

// batchProgress reads the denormalized rollup — a handful of documents,
// whatever the batch's size. Null means the rollup has not been built for this
// batch yet (a batch that predates the rollup and has not been backfilled);
// the UI says so rather than rendering zeroes as if they were the truth.
export const batchProgress = query({
  args: { batchId: v.id("batches") },
  handler: async (ctx, { batchId }) => {
    const batch = await ctx.db.get(batchId);
    if (!batch) throw new Error("batch not found");
    await gateExperimentRead(ctx, batch.experimentId);
    return await readProgress(ctx, batchId, batch.experimentId);
  },
});

// compactBatchProgress folds a batch's appended rollup deltas back into one
// row, and chains until the pile is gone. Scheduled probabilistically from the
// run mutations (see lib/batchProgressWriter.ts); it is pure maintenance and
// changes no total, so a pass that loses a race to another compaction simply
// rolls back.
export const compactBatchProgress = internalMutation({
  args: { batchId: v.id("batches") },
  handler: async (ctx, { batchId }) => {
    const result = await compactProgress(ctx, batchId);
    if (result.more) {
      await ctx.scheduler.runAfter(0, internal.runs.compactBatchProgress, {
        batchId,
      });
    }
    return result;
  },
});

export const get = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId);
    if (!run) return null;
    await gateExperimentRead(ctx, run.experimentId);
    return run;
  },
});

export const rename = mutation({
  args: { runId: v.id("runs"), name: v.string() },
  handler: async (ctx, { runId, name }) => {
    const trimmed = requireNonEmptyName(name);
    await gateRunModify(ctx, runId);
    // Run labels are intentionally not unique. Chemists commonly repeat
    // a label for reruns or method variants inside the same experiment.
    await ctx.db.patch(runId, { name: trimmed });
  },
});

// Notes and tags are the lab-notebook layer: any member who can write the
// run may annotate it (same gate as the wrapper's status updates — an
// annotation is not a destructive edit like rename/delete).
export const setNotes = mutation({
  args: { runId: v.id("runs"), notes: v.string() },
  handler: async (ctx, { runId, notes }) => {
    await gateRunWrite(ctx, runId);
    await ctx.db.patch(runId, { notes });
  },
});

const MAX_TAGS = 32;

export const setTags = mutation({
  args: { runId: v.id("runs"), tags: v.array(v.string()) },
  handler: async (ctx, { runId, tags }) => {
    await gateRunWrite(ctx, runId);
    const cleaned = [...new Set(tags.map((t) => t.trim()).filter((t) => t.length > 0))];
    if (cleaned.length > MAX_TAGS) {
      throw new Error(`too many tags (max ${MAX_TAGS})`);
    }
    await ctx.db.patch(runId, { tags: cleaned });
  },
});

// listChildren returns the runs generated from this one (restart /
// `dftstream next` lineage), newest first.
export const listChildren = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId);
    if (!run) return [];
    await gateExperimentRead(ctx, run.experimentId);
    const children = await ctx.db
      .query("runs")
      .withIndex("by_parent", (q) => q.eq("parentRunId", runId))
      .collect();
    return children.sort((a, b) => b.startedAt - a.startedAt);
  },
});

// setParent edits the lineage by hand (for runs submitted outside the
// generated-input path). Same gate as notes/tags — an annotation, not a
// destructive edit. Pass parentRunId: null to unlink.
export const setParent = mutation({
  args: {
    runId: v.id("runs"),
    parentRunId: v.union(v.id("runs"), v.null()),
    parentEdgeKind: v.optional(v.string()),
  },
  handler: async (ctx, { runId, parentRunId, parentEdgeKind }) => {
    await gateRunWrite(ctx, runId);
    if (parentRunId === null) {
      await ctx.db.patch(runId, { parentRunId: undefined, parentEdgeKind: undefined });
      return;
    }
    if (parentRunId === runId) throw new Error("a run cannot be its own parent");
    const run = await ctx.db.get(runId);
    const parent = await ctx.db.get(parentRunId);
    if (!run || !parent) throw new Error("run not found");
    const runExp = await ctx.db.get(run.experimentId);
    const parentExp = await ctx.db.get(parent.experimentId);
    if ((runExp?.organizationId ?? null) !== (parentExp?.organizationId ?? null)) {
      throw new Error("parent run belongs to a different organization");
    }
    await ctx.db.patch(runId, { parentRunId, parentEdgeKind });
  },
});

export const findByExperimentAndName = query({
  args: { experimentId: v.id("experiments"), name: v.string() },
  handler: async (ctx, { experimentId, name }) => {
    await gateExperimentRead(ctx, experimentId);
    return await ctx.db
      .query("runs")
      .withIndex("by_experiment_name", (q) =>
        q.eq("experimentId", experimentId).eq("name", name),
      )
      .first();
  },
});

// Ceiling on listRunning's read. The query is a live subscription (the
// notification bell) that re-runs on every running-set change, so it must stay
// cheap however busy the deployment gets. The oldest MAX_RUNNING running runs
// (by_status is ordered by _creationTime within a status) are returned; a
// deployment with more than that running at once sees a truncated set, and a
// run past the cutoff finishes without a toast. With auth on the cap applies
// BEFORE the org filter (there is no by_org_status index; adding one is a
// schema change), so a busy deployment can crowd an org's runs out of the
// window — revisit with a denormalized runs.organizationId if that happens.
const MAX_RUNNING = 1000;

/** A running run without its inline ORCA input: the running set feeds the
 *  notification bell, which never renders the input, and a whole input file
 *  per row turns every re-run of this subscription into megabytes. */
export type RunningRun = Omit<Doc<"runs">, "inputText">;

function withoutInputText(run: Doc<"runs">): RunningRun {
  const { inputText: _inputText, ...rest } = run;
  return rest;
}

export const listRunning = query({
  args: { organizationId: v.optional(v.id("organizations")) },
  handler: async (ctx, { organizationId }): Promise<RunningRun[]> => {
    const scope = await resolveOrgScope(ctx, organizationId);
    const running = await ctx.db
      .query("runs")
      .withIndex("by_status", (q) => q.eq("status", RUN_STATUS.RUNNING))
      .take(MAX_RUNNING);
    if (scope === null) return running.map(withoutInputText);
    // Org-scope by the run's owning experiment, one lookup per distinct
    // experiment (runs of one experiment usually run together).
    const orgOfExp = new Map<Id<"experiments">, Id<"organizations"> | undefined>();
    const out: RunningRun[] = [];
    for (const r of running) {
      if (!orgOfExp.has(r.experimentId)) {
        const exp = await ctx.db.get(r.experimentId);
        orgOfExp.set(r.experimentId, exp?.organizationId);
      }
      if (orgOfExp.get(r.experimentId) === scope) out.push(withoutInputText(r));
    }
    return out;
  },
});

// Single-run delete pops the run row in one cheap mutation, then lets
// the Convex scheduler chew through child tables in the background.
// See experiments.ts for the cascade implementation.
export { removeRunNow as remove } from "./experiments";
