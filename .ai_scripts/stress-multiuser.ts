/**
 * Multi-user write stress test for a LOCAL Convex backend.
 *
 * Answers the question the batch rollup work raised but never measured in the
 * shape people actually work in: several chemists, each running several
 * calculations, all writing at the same time. The load fixture
 * (seed-batch-load.ts) hammers ONE batch with one client; this simulates
 * independent people and, in the second scenario, the contended case where a
 * whole group feeds a single shared batch.
 *
 * Each simulated calculation reproduces the wrapper's real write pattern:
 *   create → running → (metrics + events + logs interleaved) → finished/failed
 *
 *   cd db && bun run dev              # local backend, in another shell
 *   bun .ai_scripts/stress-multiuser.ts
 *
 * Options (env):
 *   CONVEX_URL   backend origin (default http://127.0.0.1:3210)
 *   PEOPLE       simultaneous users        (default 6)
 *   RUNS         calculations per user     (default 8)
 *   CYCLES       SCF cycles reported/run   (default 12)
 *   KEEP         set to 1 to leave the data behind for inspection
 *
 * SAFETY: refuses to run against anything but a loopback backend. The tracked
 * production deployment lives in ~/.config/dftstream/config.json and must
 * never see fixture data.
 */

import { writeFileSync } from "node:fs";

const CONVEX_URL = process.env.CONVEX_URL ?? "http://127.0.0.1:3210";
const PEOPLE = Number(process.env.PEOPLE ?? 6);
const RUNS_PER_PERSON = Number(process.env.RUNS ?? 8);
const CYCLES = Number(process.env.CYCLES ?? 12);
const KEEP = process.env.KEEP === "1";

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
if (!LOOPBACK.test(new URL(CONVEX_URL).origin)) {
  console.error(
    `refusing to stress a non-local backend: ${CONVEX_URL}\n` +
      `This script writes thousands of fake runs. Point CONVEX_URL at a local backend.`,
  );
  process.exit(1);
}

const RUN_STATUS = { PENDING: "pending", RUNNING: "running", FINISHED: "finished", FAILED: "failed" } as const;
const ERROR_CLASSES = ["scf_not_converged", "out_of_memory", "opt_max_cycles", "external_tool_failed"] as const;

interface CallStat {
  readonly path: string;
  readonly ms: number;
  readonly attempts: number;
  readonly ok: boolean;
}

const stats: CallStat[] = [];
let retries = 0;
let failures = 0;

/** One Convex mutation with the same retry ladder the Go wrapper walks. */
async function mutation(path: string, args: Record<string, unknown>): Promise<any> {
  const started = performance.now();
  let lastError = "";
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch(`${CONVEX_URL}/api/mutation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, args, format: "json" }),
      });
      const body = (await res.json()) as { status?: string; value?: unknown; errorMessage?: string };
      if (res.ok && body.status === "success") {
        if (attempt > 1) retries += attempt - 1;
        stats.push({ path, ms: performance.now() - started, attempts: attempt, ok: true });
        return body.value;
      }
      lastError = body.errorMessage ?? `HTTP ${res.status}`;
    } catch (err) {
      // Network-level failure (backend restarting, socket exhausted): retried
      // below like any other transient, and surfaced if the ladder runs out.
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 2 ** attempt * 25));
  }
  failures++;
  stats.push({ path, ms: performance.now() - started, attempts: 6, ok: false });
  throw new Error(`${path} failed after 6 attempts: ${lastError}`);
}

async function query(path: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${CONVEX_URL}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const body = (await res.json()) as { status?: string; value?: unknown; errorMessage?: string };
  if (!res.ok || body.status !== "success") throw new Error(`${path}: ${body.errorMessage ?? res.status}`);
  return body.value;
}

/** One simulated calculation, writing what the wrapper writes. */
async function simulateRun(experimentId: string, batchId: string | undefined, person: number, idx: number) {
  const runId = await mutation("runs:create", {
    experimentId,
    ...(batchId ? { batchId, batchParams: { person: `chemist-${person}`, conformer: String(idx) } } : {}),
    name: `p${person}-run${idx}`,
    jobType: "OPT",
    method: "r2SCAN-3c",
    functional: "r2SCAN-3c",
    basis: "def2-mTZVPP",
    nprocs: 8,
    maxcoreMb: 3000,
    charge: 0,
    mult: idx % 5 === 0 ? 2 : 1,
    keywords: ["r2SCAN-3c", "Opt", "Freq"],
    runTypes: ["OPT", "FREQ"],
    inputText: "! r2SCAN-3c Opt Freq\n%pal nprocs 8 end\n",
    submittedBy: `chemist-${person}`,
    dftstreamVersion: "stress",
  });

  await mutation("runs:updateStatus", { runId, status: RUN_STATUS.RUNNING });

  // Interleaved telemetry, as a live run produces it.
  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    await mutation("metrics:appendMany", {
      runId,
      items: [
        { key: "scf_energy", ts: Date.now(), cycle, value: -76.4 + Math.random() * 1e-3 },
        { key: "scf_gradient", ts: Date.now(), cycle, value: 1 / cycle },
      ],
    });
    if (cycle % 4 === 0) {
      await mutation("events:appendMany", {
        runId,
        items: [{ seq: cycle, ts: Date.now(), kind: "scf_converged", payload: { cycle } }],
      });
      await mutation("logs:appendMany", {
        runId,
        items: [{ ts: Date.now(), level: "info", message: `cycle ${cycle} done` }],
      });
    }
  }

  // One run in eight fails, so the failure buckets get exercised too.
  const failed = idx % 8 === 7;
  await mutation("runs:updateStatus", {
    runId,
    status: failed ? RUN_STATUS.FAILED : RUN_STATUS.FINISHED,
    finishedAt: Date.now(),
    exitCode: failed ? 1 : 0,
    wallclockSec: 300 + Math.random() * 900,
    nprocs: 8,
    converged: !failed,
    lastEnergy: -76.4 + Math.random() * 0.05,
    ...(failed
      ? { errorClass: ERROR_CLASSES[idx % ERROR_CLASSES.length], errorExcerpt: "synthetic failure" }
      : { gibbsEh: -76.38, zpeEh: 0.0086, imaginaryModes: 0 }),
  });
  return failed;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** Results go to a file as well as stdout: Bun buffers stdout when it is a
 *  pipe, so a long run that is interrupted otherwise reports nothing at all. */
const REPORT_PATH = process.env.REPORT ?? "/tmp/dftstream-stress-report.txt";
const reportLines: string[] = [];
function emit(line: string) {
  console.log(line);
  reportLines.push(line);
  try {
    // Rewrites the whole accumulated report each time, so the file is complete
    // and current even if the run is interrupted mid-scenario.
    writeFileSync(REPORT_PATH, reportLines.join("\n") + "\n");
  } catch (err) {
    // The report file is a convenience; stdout is the real output.
    console.error("could not write report file:", err);
  }
}

function report(label: string, elapsedMs: number, calls: CallStat[]) {
  const all = calls.map((c) => c.ms);
  emit(
    `\n${label}\n` +
      `  mutations        ${calls.length}\n` +
      `  wall time        ${(elapsedMs / 1000).toFixed(1)} s\n` +
      `  throughput       ${(calls.length / (elapsedMs / 1000)).toFixed(0)} mutations/s\n` +
      `  latency p50/p95/p99  ${percentile(all, 50).toFixed(0)} / ${percentile(all, 95).toFixed(0)} / ${percentile(all, 99).toFixed(0)} ms\n` +
      `  slowest          ${Math.max(...all).toFixed(0)} ms\n` +
      `  retried calls    ${calls.filter((c) => c.attempts > 1).length}\n` +
      `  failed calls     ${calls.filter((c) => !c.ok).length}`,
  );
}

async function scenario(label: string, sharedBatch: boolean) {
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");
  const before = stats.length;
  const started = performance.now();

  let sharedExp: string | undefined;
  let sharedBatchId: string | undefined;
  if (sharedBatch) {
    sharedExp = await mutation("experiments:ensure", { name: `stress-shared-${stamp}` });
    sharedBatchId = await mutation("experiments:ensureBatch", {
      experimentId: sharedExp,
      name: `group-screen-${stamp}`,
    });
  }

  // Every "person" writes concurrently, each working through their own runs.
  const perPerson = await Promise.all(
    Array.from({ length: PEOPLE }, async (_, person) => {
      const experimentId =
        sharedExp ?? (await mutation("experiments:ensure", { name: `stress-p${person}-${stamp}` }));
      let failed = 0;
      for (let idx = 0; idx < RUNS_PER_PERSON; idx++) {
        if (await simulateRun(experimentId, sharedBatchId, person, idx)) failed++;
      }
      return { experimentId, failed };
    }),
  );

  const elapsed = performance.now() - started;
  report(label, elapsed, stats.slice(before));

  const runs = PEOPLE * RUNS_PER_PERSON;
  const expectedFailed = perPerson.reduce((n, p) => n + p.failed, 0);
  emit(`  runs written     ${runs} (${expectedFailed} failed by design)`);

  if (sharedBatchId) {
    const progress = await query("runs:batchProgress", { batchId: sharedBatchId });
    const p = progress as Record<string, number> & { failureCounts?: Record<string, number> };
    const bucketSum = Object.values(p.failureCounts ?? {}).reduce((a, b) => a + b, 0);
    const consistent =
      p.total === runs &&
      p.pending + p.running + p.finished + p.failed === runs &&
      p.failed === expectedFailed &&
      bucketSum === expectedFailed;
    emit(
      `  rollup           total=${p.total} pending=${p.pending} running=${p.running} ` +
        `finished=${p.finished} failed=${p.failed} buckets=${bucketSum}`,
    );
    emit(`  rollup consistent ${consistent ? "YES" : "NO  <-- MISMATCH"}`);
  }

  return perPerson.map((p) => p.experimentId);
}

const created = new Set<string>();
for (const id of await scenario(`A · ${PEOPLE} people, separate experiments`, false)) created.add(id);
for (const id of await scenario(`B · ${PEOPLE} people, ONE shared batch`, true)) created.add(id);

emit(
  `\nTOTAL: ${stats.length} mutations, ${retries} retried attempts, ${failures} hard failures`,
);

if (KEEP) {
  console.log("\nKEEP=1 — leaving fixture data in place.");
} else {
  for (const experimentId of created) {
    await mutation("experiments:remove", { experimentId });
  }
  console.log(`\nCleaned up ${created.size} fixture experiments.`);
}
