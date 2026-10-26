import { v } from "convex/values";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { ORG_ROLE } from "./schema";
import {
  authEnabled,
  authorizeExperimentWrite,
  currentUserId,
  gateExperimentRead,
  gateExperimentRowModify,
  gateRunModify,
  requireCanModify,
  requireMembership,
  resolveOrgScope,
} from "./authz";
import { requireNonEmptyName } from "./lib/util";
import {
  computeExperimentSummary,
  type SummaryExperiment,
} from "./lib/experimentSummary";
import {
  drainProgress,
  initProgress,
  recordRunChange,
} from "./lib/batchProgressWriter";
import {
  compactExperimentProgress as compactProgressRows,
  drainExperimentProgress,
  initExperimentProgress,
  readExperimentProgress,
} from "./lib/experimentProgressWriter";
import { drainRunChildren } from "./lib/runChildren";
import { settleRunUsage } from "./lib/artifactQuota";
import { StepBudget } from "./lib/stepBudget";
import {
  RUNS_PER_SLICE,
  STEP_DELAY_MS,
  drainExperimentTopLevel,
  madeProgress,
} from "./lib/cascade";

// Experiments named `name` in one scope: an org's (auth on) or the whole
// deployment's (auth off, scope null). Experiment names are the top-level
// namespace in the UI/importer, so they are unique per scope; every lookup
// and uniqueness check goes through here so the two index paths cannot drift.
async function experimentsNamed(
  ctx: QueryCtx,
  scope: Id<"organizations"> | null,
  name: string,
  limit: number,
): Promise<Doc<"experiments">[]> {
  return scope === null
    ? await ctx.db
        .query("experiments")
        .withIndex("by_name", (q) => q.eq("name", name))
        .take(limit)
    : await ctx.db
        .query("experiments")
        .withIndex("by_org_name", (q) =>
          q.eq("organizationId", scope).eq("name", name),
        )
        .take(limit);
}

// The experiments of one scope, newest first — the base query of both list
// views, so their index choice stays identical.
function experimentsNewestFirst(
  ctx: QueryCtx,
  scope: Id<"organizations"> | null,
) {
  return scope === null
    ? ctx.db.query("experiments").withIndex("by_createdAt").order("desc")
    : ctx.db
        .query("experiments")
        .withIndex("by_org_createdAt", (q) => q.eq("organizationId", scope))
        .order("desc");
}

export const ensure = mutation({
  args: { name: v.string(), organizationId: v.optional(v.id("organizations")) },
  handler: async (ctx, { name, organizationId }) => {
    const normalized = requireNonEmptyName(name);
    const scope = await resolveOrgScope(ctx, organizationId, ORG_ROLE.MEMBER);
    const [existing] = await experimentsNamed(ctx, scope, normalized, 1);
    if (existing) return existing._id;
    const created = await ctx.db.insert("experiments", {
      name: normalized,
      createdAt: Date.now(),
      // Org-less (and creator-less) only in local single-user mode.
      organizationId: scope ?? undefined,
      createdBy: scope === null ? undefined : await currentUserId(ctx),
    });
    // Seeds a zeroed rollup, so a brand-new experiment reads as "0 runs"
    // rather than as one whose rollup has yet to be built.
    await initExperimentProgress(ctx, created);
    return created;
  },
});

export const list = query({
  args: { organizationId: v.optional(v.id("organizations")) },
  handler: async (ctx, { organizationId }) => {
    const scope = await resolveOrgScope(ctx, organizationId);
    return await experimentsNewestFirst(ctx, scope).collect();
  },
});

export const get = query({
  args: { id: v.id("experiments") },
  handler: async (ctx, { id }) => {
    const exp = await ctx.db.get(id);
    if (!exp) return null;
    if (authEnabled()) {
      // Org-less rows are pre-import leftovers and are invisible once auth is
      // on (list/rename/remove all refuse them) — treat as not-found rather
      // than handing them to any authenticated caller.
      if (!exp.organizationId) return null;
      await requireMembership(ctx, exp.organizationId);
    }
    return exp;
  },
});

export const listBatches = query({
  args: { experimentId: v.id("experiments") },
  handler: async (ctx, { experimentId }) => {
    await gateExperimentRead(ctx, experimentId);
    return await ctx.db
      .query("batches")
      .withIndex("by_experiment_createdAt", (q) =>
        q.eq("experimentId", experimentId),
      )
      .order("desc")
      .take(200);
  },
});

export const getBatch = query({
  args: { batchId: v.id("batches") },
  handler: async (ctx, { batchId }) => {
    const batch = await ctx.db.get(batchId);
    if (!batch) return null;
    await gateExperimentRead(ctx, batch.experimentId);
    return batch;
  },
});

// --- batches ------------------------------------------------------------------

const batchArgs = {
  experimentId: v.id("experiments"),
  name: v.string(),
  description: v.optional(v.string()),
  artifactLevel: v.optional(v.string()),
};

async function batchNamed(
  ctx: QueryCtx,
  experimentId: Id<"experiments">,
  name: string,
): Promise<Doc<"batches"> | null> {
  return await ctx.db
    .query("batches")
    .withIndex("by_experiment_name", (q) =>
      q.eq("experimentId", experimentId).eq("name", name),
    )
    .first();
}

// insertBatch is the body createBatch and ensureBatch share once they have
// authorized and settled that the name is free: the row plus its zeroed
// rollup, in one transaction.
async function insertBatch(
  ctx: MutationCtx,
  fields: {
    experimentId: Id<"experiments">;
    name: string;
    description?: string;
    artifactLevel?: string;
  },
  createdBy: Id<"appUsers"> | undefined,
): Promise<Id<"batches">> {
  const batchId = await ctx.db.insert("batches", {
    experimentId: fields.experimentId,
    name: fields.name,
    description: cleanOptional(fields.description),
    artifactLevel: cleanOptional(fields.artifactLevel),
    createdAt: Date.now(),
    createdBy,
  });
  await initProgress(ctx, batchId, fields.experimentId);
  return batchId;
}

export const createBatch = mutation({
  args: batchArgs,
  handler: async (ctx, args) => {
    const name = requireNonEmptyName(args.name, "batch name");
    const writer = await authorizeExperimentWrite(ctx, args.experimentId);
    if (await batchNamed(ctx, args.experimentId, name)) {
      throw new Error(`batch ${name} already exists`);
    }
    return await insertBatch(ctx, { ...args, name }, writer?.userId);
  },
});

// ensureBatch is createBatch's idempotent twin, called by the wrapper on every
// submit: an existing batch of that name is returned, not an error.
export const ensureBatch = mutation({
  args: batchArgs,
  handler: async (ctx, args) => {
    const name = requireNonEmptyName(args.name, "batch name");
    const writer = await authorizeExperimentWrite(ctx, args.experimentId);
    const existing = await batchNamed(ctx, args.experimentId, name);
    if (existing) return existing._id;
    return await insertBatch(ctx, { ...args, name }, writer?.userId);
  },
});

export const renameBatch = mutation({
  args: { batchId: v.id("batches"), name: v.string() },
  handler: async (ctx, { batchId, name }) => {
    const batch = await ctx.db.get(batchId);
    if (!batch) throw new Error("batch not found");
    const normalized = requireNonEmptyName(name, "batch name");
    await gateExperimentRowModify(ctx, batch.experimentId, batch.createdBy);
    const matches = await ctx.db
      .query("batches")
      .withIndex("by_experiment_name", (q) =>
        q.eq("experimentId", batch.experimentId).eq("name", normalized),
      )
      .take(2);
    if (matches.find((row) => row._id !== batchId)) {
      throw new Error(`batch ${normalized} already exists`);
    }
    await ctx.db.patch(batchId, { name: normalized });
  },
});

export const removeBatch = mutation({
  args: { batchId: v.id("batches") },
  handler: async (ctx, { batchId }) => {
    const batch = await ctx.db.get(batchId);
    if (!batch) return;
    await gateExperimentRowModify(ctx, batch.experimentId, batch.createdBy);
    // Existence is all that is asked, so one row is all that is read.
    const anyRun = await ctx.db
      .query("runs")
      .withIndex("by_batch_started", (q) => q.eq("batchId", batchId))
      .first();
    if (anyRun) {
      throw new Error("cannot delete a batch that still contains runs");
    }
    await ctx.db.delete(batchId);
    // Compaction keeps the rollup to a handful of rows, but a batch deleted
    // mid-burst can hold more than one transaction may delete; whatever does
    // not fit is drained by a follow-up chain instead of being orphaned.
    if (!(await drainProgress(ctx, batchId, new StepBudget()))) {
      await ctx.scheduler.runAfter(
        STEP_DELAY_MS,
        internal.experiments._cleanupBatchProgressStep,
        { batchId },
      );
    }
  },
});

// Drains the rollup rows a removeBatch could not fit into its own
// transaction, one bounded step at a time.
export const _cleanupBatchProgressStep = internalMutation({
  args: { batchId: v.id("batches") },
  handler: async (ctx, { batchId }) => {
    const budget = new StepBudget();
    if (await drainProgress(ctx, batchId, budget)) return;
    if (!madeProgress(budget, `batch ${batchId} (rollup)`)) return;
    await ctx.scheduler.runAfter(
      STEP_DELAY_MS,
      internal.experiments._cleanupBatchProgressStep,
      { batchId },
    );
  },
});

// Experiment names are the top-level namespace in the UI/importer, so
// they must stay unique. Run names remain free to duplicate inside an
// experiment because repeated calculations often share the same label.
export const rename = mutation({
  args: { experimentId: v.id("experiments"), name: v.string() },
  handler: async (ctx, { experimentId, name }) => {
    const normalized = requireNonEmptyName(name);
    let scope: Id<"organizations"> | null = null;
    if (authEnabled()) {
      const exp = await ctx.db.get(experimentId);
      if (!exp) throw new Error("experiment not found");
      if (!exp.organizationId) throw new Error("experiment has no organization");
      await requireCanModify(ctx, exp.organizationId, exp.createdBy);
      // Uniqueness is scoped to the org.
      scope = exp.organizationId;
    }
    const matches = await experimentsNamed(ctx, scope, normalized, 2);
    if (matches.find((row) => row._id !== experimentId)) {
      throw new Error(`experiment ${normalized} already exists`);
    }
    await ctx.db.patch(experimentId, { name: normalized });
  },
});

// --- deleting an experiment ---------------------------------------------------
//
// remove pops the experiment row and hands the cascade to the scheduler; the
// chain below deletes everything underneath it one bounded transaction at a
// time. lib/cascade.ts explains the design (why bounded steps, why exactly one
// job in flight, why it terminates) and holds the unregistered helpers. The
// registered steps stay here: their names are baked into jobs already queued
// in _scheduled_functions.
export const remove = mutation({
  args: { experimentId: v.id("experiments") },
  handler: async (ctx, { experimentId }) => {
    const exp = await ctx.db.get(experimentId);
    if (!exp) return;
    // Org-less (pre-auth) rows throw "experiment has no organization" with
    // auth on — they are invisible, not deletable by anyone.
    await gateExperimentRowModify(ctx, experimentId, exp.createdBy);
    await ctx.db.delete(experimentId);
    await ctx.scheduler.runAfter(
      0,
      internal.experiments._cleanupExperimentRunsStep,
      { experimentId },
    );
  },
});

// Phase 1: pop a slice of run rows (what the runs table shows) and hand their
// ids to phase 2. No recordRunChange: the batch rollups are deleted with their
// batches in phase 3, and the experiment's own rollup in phase 4.
//
// The cascade starts here rather than at the top level so that a job left in
// _scheduled_functions by the pre-rewrite cascade — which used this same name —
// still runs the whole chain after a deploy.
export const _cleanupExperimentRunsStep = internalMutation({
  args: { experimentId: v.id("experiments") },
  handler: async (ctx, { experimentId }) => {
    const budget = new StepBudget();
    const runs = await ctx.db
      .query("runs")
      .withIndex("by_experiment_started", (q) =>
        q.eq("experimentId", experimentId),
      )
      .take(budget.rowsAffordable("runs", RUNS_PER_SLICE));
    if (runs.length === 0) {
      await ctx.scheduler.runAfter(
        STEP_DELAY_MS,
        internal.experiments._cleanupExperimentStep,
        { experimentId },
      );
      return;
    }
    for (const run of runs) {
      await ctx.db.delete(run._id);
      // Release the run's counted artifact usage in the same transaction that
      // pops the run row — the drain steps that follow know nothing about
      // accounting (see lib/artifactQuota.settleRunUsage).
      await settleRunUsage(ctx, run._id);
    }
    await ctx.scheduler.runAfter(
      STEP_DELAY_MS,
      internal.experiments._cleanupRunChildrenStep,
      { experimentId, runIds: runs.map((r) => r._id) },
    );
  },
});

// Phase 2: drain the child tables of the runs phase 1 popped, one bounded
// transaction at a time. `runIds` is the worklist — a run stays at its head
// until it is fully drained — which is what keeps the cascade serial: there is
// one chain, not one per run. Also the entry point for a single-run delete,
// which passes no experimentId and so ends the chain when the list empties.
export const _cleanupRunChildrenStep = internalMutation({
  args: {
    runIds: v.array(v.id("runs")),
    experimentId: v.optional(v.id("experiments")),
  },
  handler: async (ctx, { runIds, experimentId }) => {
    const budget = new StepBudget();
    const pending = [...runIds];
    while (pending.length > 0) {
      if (!(await drainRunChildren(ctx, pending[0]!, budget))) break;
      pending.shift();
    }
    if (pending.length === 0) {
      if (experimentId) {
        await ctx.scheduler.runAfter(
          STEP_DELAY_MS,
          internal.experiments._cleanupExperimentRunsStep,
          { experimentId },
        );
      }
      return;
    }
    if (!madeProgress(budget, `runs ${pending.slice(0, 3).join(", ")}`)) return;
    await ctx.scheduler.runAfter(
      STEP_DELAY_MS,
      internal.experiments._cleanupRunChildrenStep,
      { runIds: pending, experimentId },
    );
  },
});

// Phase 3: the experiment's own children — pathways, then batches with their
// rollup rows. After the runs, because they are the cheap part and because a
// batch's rollup must not be decremented by run deletions that are still to
// come.
export const _cleanupExperimentStep = internalMutation({
  args: { experimentId: v.id("experiments") },
  handler: async (ctx, { experimentId }) => {
    const budget = new StepBudget();
    const drained = await drainExperimentTopLevel(ctx, experimentId, budget);
    if (drained) {
      await ctx.scheduler.runAfter(
        STEP_DELAY_MS,
        internal.experiments._cleanupExperimentRollupStep,
        { experimentId },
      );
      return;
    }
    if (!madeProgress(budget, `experiment ${experimentId} (top level)`)) return;
    await ctx.scheduler.runAfter(
      STEP_DELAY_MS,
      internal.experiments._cleanupExperimentStep,
      { experimentId },
    );
  },
});

// Phase 4: the experiment's own rollup rows, last so that a delta appended by a
// mutation still in flight during phases 1-3 goes with them.
export const _cleanupExperimentRollupStep = internalMutation({
  args: { experimentId: v.id("experiments") },
  handler: async (ctx, { experimentId }) => {
    const budget = new StepBudget();
    if (await drainExperimentProgress(ctx, experimentId, budget)) return;
    if (!madeProgress(budget, `experiment ${experimentId} (rollup)`)) return;
    await ctx.scheduler.runAfter(
      STEP_DELAY_MS,
      internal.experiments._cleanupExperimentRollupStep,
      { experimentId },
    );
  },
});

// Public single-run delete. Same shape as experiments.remove: pop the
// run row first, schedule the child cleanup.
export const removeRunNow = mutation({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId);
    if (!run) return;
    await gateRunModify(ctx, runId);
    await ctx.db.delete(runId);
    // Deleting a run takes its contribution back out of the batch and
    // experiment rollups — and its artifact bytes out of the org's storage
    // quota — in the same transaction as the delete.
    await recordRunChange(ctx, run, null);
    await settleRunUsage(ctx, runId);
    await ctx.scheduler.runAfter(
      0,
      internal.experiments._cleanupRunChildrenStep,
      { runIds: [runId] },
    );
  },
});

// _cleanupRunStep is the pre-rewrite per-run cleanup entry point, kept as a
// forwarder: a deploy lands while the old cascade still has jobs queued in
// _scheduled_functions, and a scheduled call to a function that no longer
// exists fails permanently, stranding that run's children.
export const _cleanupRunStep = internalMutation({
  args: { runId: v.id("runs"), stepsLeft: v.optional(v.number()) },
  handler: async (ctx, { runId }) => {
    await ctx.scheduler.runAfter(
      0,
      internal.experiments._cleanupRunChildrenStep,
      { runIds: [runId] },
    );
  },
});

// compactExperimentProgress folds an experiment's appended rollup deltas back
// into one row, and chains until the pile is gone. Scheduled probabilistically
// by the run mutations — see lib/experimentProgressWriter.ts.
export const compactExperimentProgress = internalMutation({
  args: { experimentId: v.id("experiments") },
  handler: async (ctx, { experimentId }) => {
    const { more } = await compactProgressRows(ctx, experimentId);
    if (!more) return;
    await ctx.scheduler.runAfter(
      0,
      internal.experiments.compactExperimentProgress,
      { experimentId },
    );
  },
});

export const getByName = query({
  args: {
    name: v.string(),
    organizationId: v.optional(v.id("organizations")),
  },
  handler: async (ctx, { name, organizationId }) => {
    const normalized = requireNonEmptyName(name);
    const scope = await resolveOrgScope(ctx, organizationId);
    const [match] = await experimentsNamed(ctx, scope, normalized, 1);
    return match ?? null;
  },
});

function cleanOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

// listWithSummary returns each experiment alongside derived stats:
// run count, last activity timestamp, latest-run status, and the
// most-used functional / basis / runType across its runs.
// The UI uses this to render the experiments index as cards.
export const listWithSummary = query({
  args: {
    paginationOpts: paginationOptsValidator,
    organizationId: v.optional(v.id("organizations")),
  },
  handler: async (ctx, { paginationOpts, organizationId }) => {
    const scope = await resolveOrgScope(ctx, organizationId);
    const page = await experimentsNewestFirst(ctx, scope).paginate(
      paginationOpts,
    );
    const summaries = [];
    for (const experiment of page.page) {
      summaries.push(await summarizeExperiment(ctx, experiment));
    }
    return { ...page, page: summaries };
  },
});

// summarizeExperiment does the db reads; the tallying itself lives in
// lib/experimentSummary.ts as a pure, unit-tested function.
//
// Cost per experiment, and why it is a constant: the rollup read is bounded by
// EXPERIMENT_ROLLUP_READ_CAP tiny rows (typically a handful, after compaction)
// and the latest run is a single document. It used to read up to 500 RUN
// documents per experiment — each inlining its whole ORCA input — so one
// experiment that had grown past a few hundred runs was enough to push the
// whole page past Convex's per-query read budget. The query then threw on every
// attempt and the experiments index rendered skeletons forever.
async function summarizeExperiment(ctx: QueryCtx, e: SummaryExperiment) {
  const progress = await readExperimentProgress(ctx, e._id);
  const [latest] = await ctx.db
    .query("runs")
    .withIndex("by_experiment_started", (q) => q.eq("experimentId", e._id))
    .order("desc")
    .take(1);
  return computeExperimentSummary(
    e,
    progress?.values ?? null,
    latest ?? null,
    progress?.capped ?? false,
  );
}
