/**
 * A batch that runs in front of you, for watching the batch dashboard live.
 *
 * seed-batch-load.ts writes 5,000 already-finished runs as fast as it can —
 * that answers "does the rollup stay exact at scale", but there is nothing to
 * watch. This one simulates a real screening campaign in real time: a pool of
 * workers picks up conformers, each calculation streams SCF cycles for a while,
 * and runs finish (or fail, with a real ORCA error class) one at a time. The
 * progress bar, completions/hour, concurrency, ETA and failure table all move.
 *
 *   cd db && bun run dev                    # local backend, in another shell
 *   bun .ai_scripts/demo-batch-live.ts      # then open the batch in the UI
 *
 * Options (env):
 *   CONVEX_URL   backend origin        (default http://127.0.0.1:3210)
 *   RUNS         calculations in the batch     (default 24)
 *   WORKERS      how many run at once          (default 4)
 *   SECONDS      wall time per calculation     (default 25)
 *   FAIL_RATE    fraction that fail            (default 0.15)
 *   EXP          experiment name               (default "live-demo")
 *
 * SAFETY: refuses to run against anything but a loopback backend. The tracked
 * production deployment must never see fixture data.
 */

const CONVEX_URL = process.env.CONVEX_URL ?? "http://127.0.0.1:3210";
const RUNS = Number(process.env.RUNS ?? 24);
const WORKERS = Number(process.env.WORKERS ?? 4);
const SECONDS = Number(process.env.SECONDS ?? 25);
const FAIL_RATE = Number(process.env.FAIL_RATE ?? 0.15);
const EXPERIMENT = process.env.EXP ?? "live-demo";

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
if (!LOOPBACK.test(new URL(CONVEX_URL).origin)) {
  console.error(
    `refusing to write fixture data to a non-local backend: ${CONVEX_URL}\n` +
      `Point CONVEX_URL at a local backend.`,
  );
  process.exit(1);
}

const RUN_STATUS = { RUNNING: "running", FINISHED: "finished", FAILED: "failed" } as const;

// The failure modes the wrapper classifies, so the dashboard's failure table
// groups by cause instead of showing one undifferentiated pile.
const ERROR_CLASSES = [
  { cls: "scf_not_converged", excerpt: "SCF NOT CONVERGED AFTER 125 CYCLES" },
  { cls: "out_of_memory", excerpt: "Error (ORCA_SCF): Not enough memory available!" },
  { cls: "opt_max_cycles", excerpt: "The optimization did not converge but reached the maximum" },
  { cls: "geometry_exploded", excerpt: "Error: distance between atoms 4 and 7 is too short" },
] as const;

// A handful of substrates, so grouping by a batchParams key shows something.
const SUBSTRATES = ["benzaldehyde", "anisole", "styrene", "pyridine", "toluene", "phenol"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A real (if small) molecule, so the Structure tab has something to draw and
 * the trajectory player has frames to step through. Benzaldehyde, roughly at
 * its optimized geometry.
 *
 * Without this the run page's Structure tab is empty — geometries come from
 * the parser reading ORCA's optimization cycles, and a fixture that only
 * writes metrics has none.
 */
const BENZALDEHYDE: [string, number, number, number][] = [
  ["C", -0.7994, 1.2013, 0.0], ["C", -1.9814, 0.4654, 0.0],
  ["C", -1.9814, -0.9294, 0.0], ["C", -0.7994, -1.6653, 0.0],
  ["C", 0.3826, -0.9294, 0.0], ["C", 0.3826, 0.4654, 0.0],
  ["C", 1.6461, 1.2166, 0.0], ["O", 2.7014, 0.6300, 0.0],
  ["H", -0.7994, 2.2913, 0.0], ["H", -2.9257, 1.0104, 0.0],
  ["H", -2.9257, -1.4744, 0.0], ["H", -0.7994, -2.7553, 0.0],
  ["H", 1.3126, -1.4744, 0.0], ["H", 1.6879, 2.3166, 0.0],
];

/**
 * One optimization frame. Atoms relax toward the reference geometry as the
 * cycle number grows, starting from a deliberately distorted guess — so the
 * trajectory player shows a structure settling rather than 12 identical frames.
 */
function geometryFrame(cycle: number, cycles: number): string {
  const distortion = 0.25 * (1 - cycle / cycles);
  const lines = BENZALDEHYDE.map(([el, x, y, z], i) => {
    // Deterministic per-atom displacement, shrinking each cycle.
    const wobble = (n: number) => distortion * Math.sin(i * 1.7 + n);
    return `${el} ${(x + wobble(0)).toFixed(6)} ${(y + wobble(1)).toFixed(6)} ${(z + wobble(2)).toFixed(6)}`;
  });
  return `${BENZALDEHYDE.length}\nCycle ${cycle}\n${lines.join("\n")}\n`;
}

async function call(kind: "mutation" | "query", path: string, args: Record<string, unknown>) {
  const res = await fetch(`${CONVEX_URL}/api/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const body = (await res.json()) as { status?: string; value?: unknown; errorMessage?: string };
  if (!res.ok || body.status !== "success") {
    throw new Error(`${path}: ${body.errorMessage ?? `HTTP ${res.status}`}`);
  }
  return body.value as any;
}

/** One calculation, writing what the wrapper writes, paced like a real job. */
async function simulate(experimentId: string, batchId: string, idx: number) {
  const substrate = SUBSTRATES[idx % SUBSTRATES.length]!;
  const conformer = Math.floor(idx / SUBSTRATES.length) + 1;
  const name = `${substrate}-conf${conformer}`;

  const runId = await call("mutation", "runs:create", {
    experimentId,
    batchId,
    // Grouping keys: the dashboard can pivot the batch on either of these.
    batchParams: { substrate, conformer: String(conformer) },
    name,
    jobType: "OPT",
    method: "r2SCAN-3c",
    functional: "r2SCAN-3c",
    basis: "def2-mTZVPP",
    nprocs: 8,
    maxcoreMb: 3000,
    charge: 0,
    mult: 1,
    keywords: ["r2SCAN-3c", "Opt", "Freq", "CPCM(Toluene)"],
    runTypes: ["OPT", "FREQ"],
    solvent: "Toluene",
    inputText: `! r2SCAN-3c Opt Freq CPCM(Toluene)\n%pal nprocs 8 end\n`,
    submittedBy: "live-demo",
    dftstreamVersion: "demo",
  });
  await call("mutation", "runs:updateStatus", { runId, status: RUN_STATUS.RUNNING });

  // Stream SCF cycles for the run's lifetime. The energy walks down and the
  // gradient decays, so the convergence chart looks like an optimization
  // rather than noise.
  const failed = Math.random() < FAIL_RATE;
  const cycles = 12;
  const perCycle = (SECONDS * 1000) / cycles;
  let energy = -613.2 - Math.random() * 0.4;
  for (let cycle = 1; cycle <= cycles; cycle++) {
    // A failing run dies partway through rather than at the end.
    if (failed && cycle > cycles * 0.6) break;
    energy -= Math.random() * 2e-3;
    // The geometry the Structure tab and the trajectory player read.
    await call("mutation", "geometries:append", {
      runId,
      cycle,
      xyz: geometryFrame(cycle, cycles),
    });
    await call("mutation", "metrics:appendMany", {
      runId,
      items: [
        { key: "scf_energy", ts: Date.now(), cycle, value: energy },
        { key: "scf_gradient", ts: Date.now(), cycle, value: 0.08 / cycle + Math.random() * 1e-3 },
      ],
    });
    if (cycle % 4 === 0) {
      await call("mutation", "events:appendMany", {
        runId,
        items: [{ seq: cycle, ts: Date.now(), kind: "scf_converged", payload: { cycle } }],
      });
      await call("mutation", "logs:appendMany", {
        runId,
        items: [
          {
            ts: Date.now(),
            level: "info",
            message: `GEOMETRY OPTIMIZATION CYCLE ${cycle}: E = ${energy.toFixed(8)} Eh`,
          },
        ],
      });
    }
    await sleep(perCycle);
  }

  const err = ERROR_CLASSES[idx % ERROR_CLASSES.length]!;
  await call("mutation", "runs:updateStatus", {
    runId,
    status: failed ? RUN_STATUS.FAILED : RUN_STATUS.FINISHED,
    finishedAt: Date.now(),
    exitCode: failed ? 1 : 0,
    wallclockSec: SECONDS + Math.random() * SECONDS,
    nprocs: 8,
    converged: !failed,
    lastEnergy: energy,
    ...(failed
      ? { errorClass: err.cls, errorExcerpt: err.excerpt }
      : {
          gibbsEh: energy + 0.142,
          zpeEh: 0.198,
          // One in six finishes with an imaginary mode, so the "suspicious"
          // triage has something real to show on a minimum optimization.
          imaginaryModes: idx % 6 === 5 ? 1 : 0,
        }),
  });
  return failed;
}

const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");
const experimentId = await call("mutation", "experiments:ensure", { name: EXPERIMENT });
const batchId = await call("mutation", "experiments:ensureBatch", {
  experimentId,
  name: `conformer-screen-${stamp}`,
});

console.log(`experiment ${EXPERIMENT} · batch conformer-screen-${stamp}`);
console.log(`${RUNS} calculations, ${WORKERS} at a time, ~${SECONDS}s each`);
console.log(`≈ ${Math.ceil((RUNS / WORKERS) * SECONDS)}s total — open the batch in the UI now.\n`);

// A worker pool, so the batch has a real concurrency figure to report rather
// than everything starting and finishing at once.
let next = 0;
let done = 0;
let failures = 0;
await Promise.all(
  Array.from({ length: WORKERS }, async () => {
    for (;;) {
      const idx = next++;
      if (idx >= RUNS) return;
      if (await simulate(experimentId, batchId, idx)) failures++;
      done++;
      console.log(`  ${done}/${RUNS} complete (${failures} failed)`);
    }
  }),
);

const progress = await call("query", "runs:batchProgress", { batchId });
console.log(
  `\nrollup: total=${progress.total} finished=${progress.finished} failed=${progress.failed}`,
);
console.log(`The batch stays in ${EXPERIMENT}; delete it from the UI when you are done.`);
