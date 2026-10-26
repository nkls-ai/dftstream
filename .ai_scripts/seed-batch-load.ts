/**
 * Load fixture for the batch dashboard: seeds ~5,000 runs across every status
 * into a single batch on a LOCAL Convex backend, then prints the two numbers
 * that made this work necessary — what a capped read sees versus what the
 * batchProgress rollup knows.
 *
 * Nothing about a 5,000-run batch is verifiable by hand, and the truncation bug
 * this replaces was invisible precisely because 1,000 rows still look like a
 * plausible answer.
 *
 *   cd db && bun run dev            # local backend + function push
 *   bun .ai_scripts/seed-batch-load.ts
 *
 * Options (env):
 *   CONVEX_URL     backend origin (default http://127.0.0.1:3210)
 *   SEED_RUNS      how many runs to create (default 5000)
 *   SEED_EXP       experiment name (default "load-fixture")
 *   SEED_BATCH     batch name (default a timestamped one, so re-runs are fresh)
 *   SEED_ORG       organization id, required only when the deployment enforces
 *                  auth (this script speaks the anonymous HTTP API)
 *
 * Deliberately dependency-free: it talks to the backend's public HTTP API with
 * fetch, so it runs from anywhere in the repo without a node_modules lookup.
 */

const CONVEX_URL = process.env.CONVEX_URL ?? "http://127.0.0.1:3210";
const TOTAL_RUNS = Number(process.env.SEED_RUNS ?? 5000);
const EXPERIMENT_NAME = process.env.SEED_EXP ?? "load-fixture";
const BATCH_NAME = process.env.SEED_BATCH ?? `load-${new Date().toISOString().slice(0, 19)}`;
const ORGANIZATION_ID = process.env.SEED_ORG;

/**
 * Concurrent in-flight mutations.
 *
 * A Convex backend runs a bounded number of mutations at once (16 on the local
 * backend and the free tier). Seeding at that exact number starves the
 * scheduler, so the rollup's compaction passes get rejected and the ingest
 * crawls — keep a few slots free.
 *
 * Raising this is also the check that matters: the rollup is maintained by
 * APPENDING deltas rather than read-modify-writing one document, precisely so
 * that many clients can ingest one batch at once. The single-document version
 * of this code failed with OCC errors at CONCURRENCY=2.
 */
const CONCURRENCY = Number(process.env.SEED_CONCURRENCY ?? 8);

/** Retries for a transient backend response (overload, throttle, OCC), with
 *  exponential backoff — the same ladder the Go wrapper walks. */
const MAX_ATTEMPTS = 6;

/** Mirrors RUN_STATUS in db/convex/schema.ts. */
const RUN_STATUS = {
  PENDING: "pending",
  RUNNING: "running",
  FINISHED: "finished",
  FAILED: "failed",
} as const;
type RunStatus = (typeof RUN_STATUS)[keyof typeof RUN_STATUS];

/** Mirrors ERROR_CLASS in db/convex/schema.ts — the classes the fixture uses. */
const ERROR_CLASSES = [
  "scf_not_converged",
  "out_of_memory",
  "geometry_exploded",
  "input_error",
] as const;

/** The status mix of a real screening batch: mostly done, a tail still queued.
 *  Shares must sum to 1. */
const STATUS_MIX: { status: RunStatus; share: number }[] = [
  { status: RUN_STATUS.FINISHED, share: 0.7 },
  { status: RUN_STATUS.FAILED, share: 0.12 },
  { status: RUN_STATUS.RUNNING, share: 0.08 },
  { status: RUN_STATUS.PENDING, share: 0.1 },
];

const FUNCTIONALS = ["B3LYP", "PBE0", "wB97X-D3", "M06-2X"];
const BASES = ["def2-SVP", "def2-TZVP", "def2-QZVPP"];
const SOLVENTS = ["gas", "water", "thf", "toluene"];

// --- Convex HTTP API ---------------------------------------------------------

type ConvexResponse<T> =
  | { status: "success"; value: T }
  | { status: "error"; errorMessage: string; errorData?: unknown };

async function call<T>(
  kind: "query" | "mutation",
  path: string,
  args: Record<string, unknown>,
): Promise<T> {
  let lastError = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await Bun.sleep(Math.min(2000, 100 * 2 ** attempt));
    const res = await fetch(`${CONVEX_URL}/api/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, args, format: "json" }),
    });
    const text = await res.text();
    if (!res.ok) {
      // 429/5xx are the transient family (write throttle, backend overload,
      // exhausted OCC retries) — back off, exactly as the wrapper does.
      if (res.status === 429 || res.status >= 500) {
        lastError = `HTTP ${res.status} ${text.slice(0, 200)}`;
        continue;
      }
      throw new Error(`${kind} ${path} failed: HTTP ${res.status} ${text.slice(0, 400)}`);
    }
    const body = JSON.parse(text) as ConvexResponse<T>;
    if (body.status === "error") {
      if (/concurrent|too many|timed out/i.test(body.errorMessage)) {
        lastError = body.errorMessage;
        continue;
      }
      throw new Error(`${kind} ${path} failed: ${body.errorMessage}`);
    }
    return body.value;
  }
  throw new Error(
    `${kind} ${path} failed after ${MAX_ATTEMPTS} attempts: ${lastError}`,
  );
}

/** Runs `task` over `items` with a bounded number in flight. Rejects on the
 *  first failure — a half-seeded fixture is not worth debugging around. */
async function mapLimit<T>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      const item = items[index];
      if (item === undefined) return;
      await task(item, index);
    }
  });
  await Promise.all(workers);
}

// --- deterministic pseudo-randomness -----------------------------------------

/** mulberry32: a seeded PRNG, so two runs of the fixture produce the same
 *  batch and a number that looks wrong can be chased. */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = makeRandom(20260725);

function pick<T>(values: readonly T[]): T {
  return values[Math.floor(rand() * values.length)]!;
}

/** Log-normal-ish wallclock in seconds: a long right tail, like real jobs. */
function wallclockSec(): number {
  return Math.round(60 * Math.exp(rand() * 2.2));
}

function statusFor(index: number): RunStatus {
  const position = (index % 100) / 100;
  let cumulative = 0;
  for (const entry of STATUS_MIX) {
    cumulative += entry.share;
    if (position < cumulative) return entry.status;
  }
  return RUN_STATUS.PENDING;
}

// --- the fixture -------------------------------------------------------------

interface SeedPlan {
  index: number;
  status: RunStatus;
}

async function main(): Promise<void> {
  console.log(`seeding ${TOTAL_RUNS} runs into ${CONVEX_URL}`);

  const experimentId = await call<string>("mutation", "experiments:ensure", {
    name: EXPERIMENT_NAME,
    organizationId: ORGANIZATION_ID,
  });
  const batchId = await call<string>("mutation", "experiments:ensureBatch", {
    experimentId,
    name: BATCH_NAME,
    artifactLevel: "io",
  });
  console.log(`experiment ${experimentId} · batch ${BATCH_NAME} (${batchId})`);

  const plans: SeedPlan[] = Array.from({ length: TOTAL_RUNS }, (_, index) => ({
    index,
    status: statusFor(index),
  }));

  const startedAt = Date.now();
  let done = 0;
  await mapLimit(plans, CONCURRENCY, async (plan) => {
    await seedRun(experimentId, batchId, plan);
    done++;
    if (done % 500 === 0) {
      const rate = done / ((Date.now() - startedAt) / 1000);
      console.log(`  ${done}/${TOTAL_RUNS} (${rate.toFixed(0)} runs/s)`);
    }
  });

  await report(batchId);
}

async function seedRun(
  experimentId: string,
  batchId: string,
  plan: SeedPlan,
): Promise<void> {
  const functional = pick(FUNCTIONALS);
  const basis = pick(BASES);
  const solvent = pick(SOLVENTS);
  const runId = await call<string>("mutation", "runs:create", {
    experimentId,
    batchId,
    name: `conf-${String(plan.index).padStart(4, "0")}`,
    batchParams: { functional, basis, solvent },
    functional,
    basis,
    runTypes: ["OPT", "FREQ"],
    nprocs: 8,
    ncores: 8,
    // The column the projected listing must never ship back: ~2 KB per run,
    // which is 10 MB across this fixture.
    inputText: buildInput(functional, basis, solvent),
  });

  if (plan.status === RUN_STATUS.PENDING) return;

  await call("mutation", "runs:updateStatus", {
    runId,
    status: RUN_STATUS.RUNNING,
  });
  if (plan.status === RUN_STATUS.RUNNING) return;

  const wallclock = wallclockSec();
  if (plan.status === RUN_STATUS.FAILED) {
    await call("mutation", "runs:updateStatus", {
      runId,
      status: RUN_STATUS.FAILED,
      exitCode: 1,
      // A quarter of the failures stay unclassified, so the dashboard's
      // exit-code fallback is exercised too (the classifier lands separately).
      errorClass: rand() < 0.75 ? pick(ERROR_CLASSES) : undefined,
      wallclockSec: Math.round(wallclock / 4),
      finishedAt: Date.now(),
    });
    return;
  }

  // Finished. A tenth are left without thermochemistry and a twentieth carry
  // an imaginary mode, so the quality rates are not all zero.
  const energy = -76.4 - rand() * 0.05;
  const hasThermo = rand() > 0.1;
  await call("mutation", "runs:updateStatus", {
    runId,
    status: RUN_STATUS.FINISHED,
    exitCode: 0,
    converged: rand() > 0.05,
    lastEnergy: energy,
    gibbsEh: hasThermo ? energy + 0.03 : undefined,
    gMinusEEh: hasThermo ? 0.03 : undefined,
    imaginaryModes: rand() < 0.05 ? 1 : 0,
    wallclockSec: wallclock,
    finishedAt: Date.now(),
  });
}

function buildInput(functional: string, basis: string, solvent: string): string {
  const header = `! ${functional} ${basis} Opt Freq${solvent === "gas" ? "" : ` CPCM(${solvent})`}`;
  // Padding stands in for the geometry block of a real input — the point is
  // that this column is big and must not ride along in a table page.
  const padding = Array.from(
    { length: 40 },
    (_, i) => `C   ${(i * 0.1).toFixed(4)}   0.0000   0.0000`,
  ).join("\n");
  return `${header}\n%pal nprocs 8 end\n*xyz 0 1\n${padding}\n*\n`;
}

async function report(batchId: string): Promise<void> {
  const rollup = await call<Record<string, number> | null>(
    "query",
    "runs:batchProgress",
    { batchId },
  );
  // What the dashboard used to do: read a capped slice and tally it. 1000 was
  // the old .take() cap, so ask for exactly that.
  const capped = await call<{ page: unknown[] }>("query", "runs:listByBatchPaged", {
    batchId,
    paginationOpts: { numItems: 1000, cursor: null },
  });

  console.log("\n--- what a capped client-side tally sees ---");
  console.log(`  runs loaded: ${capped.page.length}`);
  console.log("--- what the batchProgress rollup knows ---");
  if (!rollup) {
    console.log("  no rollup row (backfill has not run for this batch)");
    return;
  }
  for (const key of [
    "total",
    "pending",
    "running",
    "finished",
    "failed",
    "converged",
    "notConverged",
    "withImaginary",
    "missingThermo",
    "suspicious",
    "energyCount",
    "coreSecondsSum",
  ]) {
    console.log(`  ${key}: ${rollup[key]}`);
  }
  console.log(
    `\n  the old dashboard would have reported ${capped.page.length} runs for a ${rollup.total}-run batch`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
