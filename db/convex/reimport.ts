import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { ARTIFACT_KIND, RUN_STATUS } from "./schema";
import { recordRunChange } from "./lib/batchProgressWriter";
import { gateExperimentRead, gateRunRead, gateRunWrite } from "./authz";

// Backend half of `dftstream reimport` (P0-5 backfill tooling).
//
// The wrapper's parser improves over time; rows written by an older wrapper can
// carry verdicts the current parser would not produce (the changelog records
// old rows with a wrong `converged=true`). Reimport re-runs the CURRENT parser
// over each run's stored .out and patches ONLY the parser-derived fields —
// never user data (name/notes/tags), never execution facts (status/exitCode/
// startedAt/finishedAt), never the ORCA files themselves.
//
// Three functions, gated exactly like the equivalent runs.ts paths:
//   listRuns   — paged, stable-ordered run listing for one experiment (read
//                gate, same as runs.listByExperiment);
//   findOutput — resolve the run's .out artifact (read gate, same as
//                artifacts.listForRun); the BODY is then fetched through the
//                existing artifacts.getContent so the chunk/storage/encoding
//                logic lives in exactly one place;
//   apply      — patch the whitelisted fields (write gate, same as
//                runs.updateStatus).

// projectReimportRow returns the slice of a runs row the reimport client
// needs: identity, the execution facts the recompute is parameterized on, the
// input text (for run-type semantics), the current parser-derived values (for
// drift computation), and the reimport bookkeeping stamps. Deliberately NOT
// the whole document — notes/tags and friends stay server-side.
function projectReimportRow(run: Doc<"runs">) {
  return {
    _id: run._id,
    name: run.name,
    status: run.status,
    exitCode: run.exitCode,
    startedAt: run.startedAt,
    inputText: run.inputText,
    inputPath: run.inputPath,
    cwd: run.cwd,
    lastEnergy: run.lastEnergy,
    wallclockSec: run.wallclockSec,
    converged: run.converged,
    optMaxCycles: run.optMaxCycles,
    imaginaryModes: run.imaginaryModes,
    zpeEh: run.zpeEh,
    enthalpyEh: run.enthalpyEh,
    entropyCorrEh: run.entropyCorrEh,
    gibbsEh: run.gibbsEh,
    gMinusEEh: run.gMinusEEh,
    s2: run.s2,
    s2Ideal: run.s2Ideal,
    errorClass: run.errorClass,
    errorExcerpt: run.errorExcerpt,
    reimportedAt: run.reimportedAt,
    reimportedWith: run.reimportedWith,
  };
}

// listRuns pages one experiment's runs in a STABLE order (startedAt ascending
// via by_experiment_started) so an interrupted sweep resumes deterministically.
// Rows inline inputText (a whole ORCA input file), so callers keep pages small
// — the wrapper uses 50.
export const listRuns = query({
  args: {
    experimentId: v.id("experiments"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { experimentId, paginationOpts }) => {
    await gateExperimentRead(ctx, experimentId);
    const page = await ctx.db
      .query("runs")
      .withIndex("by_experiment_started", (q) =>
        q.eq("experimentId", experimentId),
      )
      .order("asc")
      .paginate(paginationOpts);
    return { ...page, page: page.page.map(projectReimportRow) };
  },
});

// findOutput resolves the artifact holding the run's ORCA output text: the
// `.out` captured as kind "output" (offline imports), falling back to the
// "stdout" capture (live runs, where stdout IS the .out stream). Returns null
// when neither exists — the wrapper then falls back to the local file, or
// skips the run. Metadata only; the body goes through artifacts.getContent.
export const findOutput = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    await gateRunRead(ctx, runId);
    for (const kind of [ARTIFACT_KIND.OUTPUT, ARTIFACT_KIND.STDOUT]) {
      const row = await ctx.db
        .query("artifacts")
        .withIndex("by_run_kind", (q) => q.eq("runId", runId).eq("kind", kind))
        .first();
      if (row) {
        return {
          artifactId: row._id,
          name: row.name,
          path: row.path,
          kind: row.kind,
          sizeBytes: row.sizeBytes,
          truncated: row.truncated ?? false,
        };
      }
    }
    return null;
  },
});

// The exact fields reimport may rewrite — the parser-derived subset of
// runColumns, nothing else. Split by clearing semantics:
//
//   value      → set the field to this value;
//   null       → CLEAR the field (the current parser says it must be absent —
//                e.g. thermochemistry that belonged to a pre-convergence
//                hessian, which the phase-aware parser now gates out);
//   absent     → leave the stored field untouched.
//
// lastEnergy/wallclockSec are measurements rather than verdicts and are
// deliberately NOT clearable: a value the live stream captured is never erased
// because a re-parse could not reproduce it.
const REIMPORT_MEASUREMENTS = {
  lastEnergy: v.optional(v.number()),
  wallclockSec: v.optional(v.number()),
};

const REIMPORT_VERDICTS = {
  converged: v.optional(v.union(v.boolean(), v.null())),
  optMaxCycles: v.optional(v.union(v.boolean(), v.null())),
  imaginaryModes: v.optional(v.union(v.number(), v.null())),
  zpeEh: v.optional(v.union(v.number(), v.null())),
  enthalpyEh: v.optional(v.union(v.number(), v.null())),
  entropyCorrEh: v.optional(v.union(v.number(), v.null())),
  gibbsEh: v.optional(v.union(v.number(), v.null())),
  gMinusEEh: v.optional(v.union(v.number(), v.null())),
  s2: v.optional(v.union(v.number(), v.null())),
  s2Ideal: v.optional(v.union(v.number(), v.null())),
  errorClass: v.optional(v.union(v.string(), v.null())),
  errorExcerpt: v.optional(v.union(v.string(), v.null())),
};

// apply patches one run's parser-derived fields and stamps the reimport
// bookkeeping (reimportedAt server-side, reimportedWith from the wrapper).
// Gated exactly like runs.updateStatus (gateRunWrite). The arg validator IS
// the whitelist: status, exitCode, notes, tags, name — anything not listed
// above — is rejected at the door, so this mutation cannot touch user data or
// execution facts even by accident. Idempotent: re-applying identical values
// changes nothing but the stamp (and the wrapper only calls it on drift).
export const apply = mutation({
  args: {
    runId: v.id("runs"),
    // Wrapper build performing the reimport (version.Version), stored so a
    // later sweep can tell which rows an old parser last touched.
    reimportedWith: v.string(),
    ...REIMPORT_MEASUREMENTS,
    ...REIMPORT_VERDICTS,
  },
  handler: async (ctx, { runId, reimportedWith, ...fields }) => {
    await gateRunWrite(ctx, runId);
    const before = await ctx.db.get(runId);
    if (!before) throw new Error("run not found");
    // Only terminal runs have a final verdict to recompute; patching a live
    // run would race the wrapper's own status updates.
    if (
      before.status !== RUN_STATUS.FINISHED &&
      before.status !== RUN_STATUS.FAILED
    ) {
      throw new Error("reimport only applies to finished or failed runs");
    }
    const changes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue; // absent → stored field untouched
      // null → remove the field (ctx.db.patch deletes undefined-valued keys).
      changes[key] = value === null ? undefined : value;
    }
    changes.reimportedAt = Date.now();
    changes.reimportedWith = reimportedWith;
    await ctx.db.patch(runId, changes as Partial<Doc<"runs">>);
    // Same-transaction rollup maintenance as runs.updateStatus: the batch
    // dashboard's converged/thermo/failure tallies must follow the patch.
    // ctx.db.patch is a shallow merge (undefined deletes), so the post-write
    // document is exactly this spread — no second read needed.
    await recordRunChange(ctx, before, { ...before, ...changes } as Doc<"runs">);
  },
});
