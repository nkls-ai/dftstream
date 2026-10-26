import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { WithoutSystemFields } from "convex/server";
import { OPS_PER_STORAGE_DELETE, StepBudget } from "./stepBudget";

// Shared write helpers for the per-run child tables (events, logs, metrics,
// sysSamples, frequencies, excitedStates, nmrShields, artifacts). Their
// mutations all follow one of two shapes:
//   append:  insert every item under runId (appendMany / appendToRun)
//   replace: delete the run's existing rows, then append (setAll)
// Centralizing the loops keeps ordering + return semantics identical across
// modules: items are inserted in input order and ids come back in that order.

// The run-child table unions, each defined exactly once and derived from the
// one before, so adding a table is one edit rather than three that can drift.

// Tables written through appendRunChildren: rows hang off a run via `runId`
// and are inserted in bulk. (geometries also has a `runId`, but is written by
// its own per-cycle upsert in geometries.ts.)
export type RunChildTable =
  | "events"
  | "logs"
  | "metrics"
  | "sysSamples"
  | "frequencies"
  | "excitedStates"
  | "nmrShields"
  | "artifacts";

/** Tables whose rows a run cascade deletes: every run child, plus geometries,
 *  plus artifactChunks (which hang off an artifact, not the run). */
export type RunChildDeleteTable = RunChildTable | "geometries" | "artifactChunks";

/** The cascade tables drained by a plain index slice. artifacts and
 *  artifactChunks are drained bottom-up by drainArtifacts instead, because an
 *  artifact's body lives in chunk rows and file storage that must go first. */
type SlicedRunChildTable = Exclude<
  RunChildDeleteTable,
  "artifacts" | "artifactChunks"
>;

// One insertable item: the table's columns minus runId (supplied by the
// caller) and the system fields (supplied by Convex).
export type RunChildItem<T extends RunChildTable> = Omit<
  WithoutSystemFields<Doc<T>>,
  "runId"
>;

// appendRunChildren inserts the items in order and returns their ids in the
// same order. Callers that must not change their public return value (the
// appendMany family returns nothing) simply ignore the result.
export async function appendRunChildren<T extends RunChildTable>(
  ctx: MutationCtx,
  table: T,
  runId: Id<"runs">,
  items: RunChildItem<T>[],
): Promise<Id<T>[]> {
  const ids: Id<T>[] = [];
  for (const item of items) {
    // The spread is by construction exactly the table's non-system columns,
    // but TypeScript cannot relate the generic Omit back to the insert type,
    // so it requires the double cast through unknown.
    ids.push(
      await ctx.db.insert(table, {
        runId,
        ...item,
      } as unknown as WithoutSystemFields<Doc<T>>),
    );
  }
  return ids;
}

// Per-table run-scoped queries for the replace path. A lookup of concrete
// closures (instead of a generic withIndex call) keeps every index name and
// field fully type-checked against the schema.
const runChildQueries: {
  [T in "frequencies" | "excitedStates" | "nmrShields"]: (
    ctx: MutationCtx,
    runId: Id<"runs">,
  ) => Promise<Doc<T>[]>;
} = {
  frequencies: (ctx, runId) =>
    ctx.db
      .query("frequencies")
      .withIndex("by_run_idx", (q) => q.eq("runId", runId))
      .collect(),
  excitedStates: (ctx, runId) =>
    ctx.db
      .query("excitedStates")
      .withIndex("by_run_idx", (q) => q.eq("runId", runId))
      .collect(),
  nmrShields: (ctx, runId) =>
    ctx.db
      .query("nmrShields")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect(),
};

export type ReplaceableRunChildTable = keyof typeof runChildQueries;

// replaceRunChildren deletes every existing row for the run, then inserts the
// items in order (the delete-all-then-insert body previously copy-pasted into
// each setAll). artifacts.setAll stays custom in artifacts.ts because its
// delete path must also destroy storage blobs and artifactChunks; it reuses
// appendRunChildren for the insert half.
export async function replaceRunChildren<T extends ReplaceableRunChildTable>(
  ctx: MutationCtx,
  table: T,
  runId: Id<"runs">,
  items: RunChildItem<T>[],
): Promise<Id<T>[]> {
  const existing = await runChildQueries[table](ctx, runId);
  for (const row of existing) {
    await ctx.db.delete(row._id);
  }
  return await appendRunChildren(ctx, table, runId, items);
}

// --- deletion ----------------------------------------------------------------
//
// Every table that hangs off a run, in the order a cascade must drain them.
// artifacts are handled separately (below) because their bodies live in two
// other places — artifactChunks rows and file storage — which have to go first
// or they are orphaned with nothing left pointing at them.

/** One drainable child table: how to read a bounded slice of one run's rows,
 *  and how big a slice may get before the byte budget rules.
 *
 *  The `slice` closures are spelled out per table rather than generated, so
 *  every index name and field stays checked against the schema — same reason
 *  runChildQueries above is a lookup of concrete closures. */
type ChildSliceSpec = {
  table: SlicedRunChildTable;
  /** Ceiling on one `.take`, independent of the budget. Rows this big are
   *  cheap in operations but the budget still has to hold the bytes. */
  maxRowsPerSlice: number;
  slice: (
    ctx: MutationCtx,
    runId: Id<"runs">,
    limit: number,
  ) => Promise<{ _id: Id<RunChildDeleteTable> }[]>;
};

const RUN_CHILD_SLICES: ChildSliceSpec[] = [
  {
    table: "events",
    maxRowsPerSlice: 256,
    slice: (ctx, runId, limit) =>
      ctx.db
        .query("events")
        .withIndex("by_run_seq", (q) => q.eq("runId", runId))
        .take(limit),
  },
  {
    table: "logs",
    maxRowsPerSlice: 256,
    slice: (ctx, runId, limit) =>
      ctx.db
        .query("logs")
        .withIndex("by_run_ts", (q) => q.eq("runId", runId))
        .take(limit),
  },
  {
    table: "metrics",
    maxRowsPerSlice: 256,
    slice: (ctx, runId, limit) =>
      ctx.db
        .query("metrics")
        .withIndex("by_run_key_ts", (q) => q.eq("runId", runId))
        .take(limit),
  },
  {
    table: "geometries",
    maxRowsPerSlice: 64,
    slice: (ctx, runId, limit) =>
      ctx.db
        .query("geometries")
        .withIndex("by_run_cycle", (q) => q.eq("runId", runId))
        .take(limit),
  },
  {
    table: "sysSamples",
    maxRowsPerSlice: 256,
    slice: (ctx, runId, limit) =>
      ctx.db
        .query("sysSamples")
        .withIndex("by_run_ts", (q) => q.eq("runId", runId))
        .take(limit),
  },
  {
    table: "frequencies",
    maxRowsPerSlice: 256,
    slice: (ctx, runId, limit) =>
      ctx.db
        .query("frequencies")
        .withIndex("by_run_idx", (q) => q.eq("runId", runId))
        .take(limit),
  },
  {
    table: "excitedStates",
    maxRowsPerSlice: 256,
    slice: (ctx, runId, limit) =>
      ctx.db
        .query("excitedStates")
        .withIndex("by_run_idx", (q) => q.eq("runId", runId))
        .take(limit),
  },
  {
    table: "nmrShields",
    maxRowsPerSlice: 256,
    slice: (ctx, runId, limit) =>
      ctx.db
        .query("nmrShields")
        .withIndex("by_run", (q) => q.eq("runId", runId))
        .take(limit),
  },
];

/** Artifacts per slice. Small because each row carries an inline head preview
 *  of the body, and each may drag a storage blob delete along with it. */
const ARTIFACTS_PER_SLICE = 4;
/** Chunks per slice. 4 x ~512 KiB = 2 MiB, half of a step's byte budget. */
const CHUNKS_PER_SLICE = 4;

/**
 * drainRunChildren deletes as much of one run's child data as `budget` allows.
 *
 * Returns true when the run has no children left, false when the budget ran
 * out first — in which case the caller must schedule another step, which will
 * resume exactly here (every table is drained from the front of its index, so
 * there is no cursor to carry).
 *
 * Guaranteed forward progress: with a fresh budget `rowsAffordable` is >= 1 for
 * every table, so a step that returns false has deleted at least one row.
 */
export async function drainRunChildren(
  ctx: MutationCtx,
  runId: Id<"runs">,
  budget: StepBudget,
): Promise<boolean> {
  if (!(await drainArtifacts(ctx, runId, budget))) return false;
  for (const spec of RUN_CHILD_SLICES) {
    for (;;) {
      const limit = budget.rowsAffordable(spec.table, spec.maxRowsPerSlice);
      if (limit === 0) return false;
      budget.spendOps(1); // the index probe behind .take
      const rows = await spec.slice(ctx, runId, limit);
      budget.spendRows(spec.table, rows.length);
      for (const row of rows) await ctx.db.delete(row._id);
      // A short slice means the index held nothing more for this run.
      if (rows.length < limit) break;
    }
  }
  return true;
}

// drainArtifacts deletes a run's artifacts bottom-up: an artifact's chunk rows
// and storage blob first, then the artifact row itself. Bailing out midway
// leaves a still-referenced artifact rather than an orphaned body.
async function drainArtifacts(
  ctx: MutationCtx,
  runId: Id<"runs">,
  budget: StepBudget,
): Promise<boolean> {
  for (;;) {
    const limit = budget.rowsAffordable("artifacts", ARTIFACTS_PER_SLICE);
    if (limit === 0) return false;
    budget.spendOps(1);
    const artifacts = await ctx.db
      .query("artifacts")
      .withIndex("by_run_name", (q) => q.eq("runId", runId))
      .take(limit);
    budget.spendRows("artifacts", artifacts.length);
    for (const artifact of artifacts) {
      if (!(await drainArtifactChunks(ctx, artifact._id, budget))) return false;
      if (artifact.storageId) {
        await ctx.storage.delete(artifact.storageId);
        budget.spendOps(OPS_PER_STORAGE_DELETE);
      }
      await ctx.db.delete(artifact._id);
    }
    if (artifacts.length < limit) return true;
  }
}

async function drainArtifactChunks(
  ctx: MutationCtx,
  artifactId: Id<"artifacts">,
  budget: StepBudget,
): Promise<boolean> {
  for (;;) {
    const limit = budget.rowsAffordable("artifactChunks", CHUNKS_PER_SLICE);
    if (limit === 0) return false;
    budget.spendOps(1);
    const chunks = await ctx.db
      .query("artifactChunks")
      .withIndex("by_artifact_idx", (q) => q.eq("artifactId", artifactId))
      .take(limit);
    budget.spendRows("artifactChunks", chunks.length);
    for (const chunk of chunks) await ctx.db.delete(chunk._id);
    if (chunks.length < limit) return true;
  }
}
