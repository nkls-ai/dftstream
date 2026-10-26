/**
 * Live shots: starts a streaming batch (demo-batch-live.ts) and one run
 * streamed through the real wrapper (`dftstream run` with fake-orca.sh
 * replaying a real ORCA output), then captures while they are in flight:
 *
 *   experiments.png       index with running work
 *
 *   LD_LIBRARY_PATH=~/.cache/orbital-chrome-libs bun .ai_scripts/readme-screenshots/live.ts
 *
 * LOCAL backend only (127.0.0.1:3210).
 */
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { curatedExperimentsShot, launch, newPage, writeStill } from "./capture";
import { CONVEX, m, q, start, waitFor } from "./lib";

const UI = process.env.OS_UI_URL ?? "http://localhost:3000";
const OUT = process.env.OS_OUT_DIR ?? join(import.meta.dir, "../../docs/images");
const REPO = join(import.meta.dir, "../..");
const HERE = import.meta.dir;

const LIVE = {
  batchExp: "benzaldehyde-screen",
  runExp: "acrylophenone-conformers",
  runName: "opt-freq-rerun",
  source: join(REPO, ".examples/opt-freq_ma1_r2scan3c"),
  stage: "/tmp/orca-live/acrylophenone-conformers",
} as const;


/** Removes what a previous live.ts pass left behind, so names stay unique. */
async function cleanPrevious(): Promise<void> {
  const batchExp = await q("experiments:getByName", { name: LIVE.batchExp });
  if (batchExp) await m("experiments:remove", { experimentId: batchExp._id });
  const exp = await q("experiments:getByName", { name: LIVE.runExp });
  const old = exp && (await q("runs:findByExperimentAndName", { experimentId: exp._id, name: LIVE.runName }));
  if (old) await m("experiments:removeRunNow", { runId: old._id });
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const logs = process.env.LIVE_LOG_DIR ?? "/tmp/orca-live-logs";
  await mkdir(logs, { recursive: true });

  // Stage a copy of the input (never the original) where the wrapper runs it.
  await rm(LIVE.stage, { recursive: true, force: true });
  await mkdir(LIVE.stage, { recursive: true });
  await cp(join(LIVE.source, "opt-freq_ma1_r2scan3c.inp"), join(LIVE.stage, "opt-freq_ma1_r2scan3c.inp"));
  await cp(join(LIVE.source, "goat_ma1_xtb.globalminimum.xyz"), join(LIVE.stage, "goat_ma1_xtb.globalminimum.xyz"));

  await cleanPrevious();
  console.log("starting live batch + streamed run");
  const batch = start("bun", [join(REPO, ".ai_scripts/demo-batch-live.ts")], {
    CONVEX_URL: CONVEX, EXP: LIVE.batchExp, RUNS: "48", WORKERS: "6", SECONDS: "45", FAIL_RATE: "0.12",
  }, join(logs, "batch.log"));
  // Let the batch get going first, so the run is the newest thing on screen.
  await Bun.sleep(8000);
  const run = start(join(REPO, "wrapper/bin/dftstream"), [
    "run", "-orca", join(HERE, "fake-orca.sh"), "-orbitals", "none", "-sysinterval", "2s",
    "-exp", LIVE.runExp, "-name", LIVE.runName, "-tracker-url", `convex+${CONVEX}`,
    join(LIVE.stage, "opt-freq_ma1_r2scan3c.inp"),
  ], { FAKE_ORCA_SRC: LIVE.source, FAKE_ORCA_SCF_DELAY: "0.22", FAKE_ORCA_CYCLE_DELAY: "1.5" }, join(logs, "run.log"));

  const exp = await waitFor("run experiment", () => q("experiments:getByName", { name: LIVE.runExp }));
  const runDoc = await waitFor("streamed run", () => q("runs:findByExperimentAndName", { experimentId: exp._id, name: LIVE.runName }));
  const batchExp = await waitFor("batch experiment", () => q("experiments:getByName", { name: LIVE.batchExp }));
  const runPath = `/experiments/${exp._id}/runs/${runDoc._id}`;
  console.log(`  run page ${runPath}`);

  const browser = await launch();
  const errors: string[] = [];
  try {
    // Mid-run still: the index with work in flight.
    await Bun.sleep(30_000);
    const p0 = await newPage(browser, errors);
    await p0.goto(`${UI}/experiments`, { waitUntil: "networkidle" });
    await p0.waitForTimeout(3000);
    await writeStill(await curatedExperimentsShot(p0), "experiments");
    await p0.close();
  } finally {
    await browser.close();
  }
  console.log("waiting for the batch and the run to finish (neither may be left half-run)");
  await new Promise((r) => (batch.exitCode === null ? batch.on("exit", r) : r(null)));
  await new Promise((r) => (run.exitCode === null ? run.on("exit", r) : r(null)));
  if (errors.length) {
    console.error(`\n${errors.length} page error(s):`);
    for (const e of errors) console.error(`  ! ${e}`);
  }
}

await main();
