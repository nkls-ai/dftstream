/**
 * live-run.gif: a transition-state search streamed through the real wrapper
 * (`dftstream run` with fake-orca.sh replaying a real ORCA output), recorded
 * on the Transition State tab so the 3D structure and the energy chart move
 * as each optimization cycle arrives.
 *
 * The source is the organoselenium OptTS (35 atoms, 36 cycles, 0.74 Å RMS
 * displacement from first to last frame), so the geometry visibly changes.
 *
 *   source env.sh && bun gif.ts          (backend on 3210 + UI dev server up)
 *
 * LOCAL backend only (127.0.0.1:3210). Works on staged copies; the source
 * files are only read.
 */
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launch, newPage } from "./capture";
import { CONVEX, m, q, start, waitFor, writeGif } from "./lib";

const UI = process.env.OS_UI_URL ?? "http://localhost:3000";
const OUT = process.env.OS_OUT_DIR ?? join(import.meta.dir, "../../docs/images");
const REPO = join(import.meta.dir, "../..");
const HERE = import.meta.dir;

const STEM = "optts_ma2-r1_r2scan3c_2_009";
const RUN = {
  exp: "organoselenium-radical-ts",
  name: "optts-live",
  source: join(REPO, ".examples", STEM),
  input: join(REPO, "wrapper/internal/parser/testdata/corpus/6.1", `${STEM}.inp`),
  // The input reads its start geometry from this file (a scan point).
  xyzName: "surfscan_ma2-r1_r2scan3c_2.009.xyz",
  stage: "/tmp/orca-live/organoselenium-radical-ts",
} as const;

const GIF = { width: 1280, height: 800, frameMs: 900, playMs: 220, maxSeconds: 120 } as const;

// First frame of ORCA's optimization trajectory: the geometry the job starts from.
async function firstTrajectoryFrame(): Promise<string> {
  const trj = await readFile(join(RUN.source, "stuff", `${STEM}_trj.xyz`), "utf8");
  const lines = trj.split("\n");
  const n = Number(lines[0]);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`bad trajectory header: ${lines[0]}`);
  return lines.slice(0, n + 2).join("\n") + "\n";
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const logs = process.env.LIVE_LOG_DIR ?? "/tmp/orca-live-logs";
  await mkdir(logs, { recursive: true });

  await rm(RUN.stage, { recursive: true, force: true });
  await mkdir(RUN.stage, { recursive: true });
  const inp = join(RUN.stage, `${STEM}.inp`);
  await cp(RUN.input, inp);
  await writeFile(join(RUN.stage, RUN.xyzName), await firstTrajectoryFrame());

  const exp = await q("experiments:getByName", { name: RUN.exp });
  const old = exp && (await q("runs:findByExperimentAndName", { experimentId: exp._id, name: RUN.name }));
  if (old) await m("experiments:removeRunNow", { runId: old._id });

  console.log("streaming the TS search");
  const run = start(join(REPO, "wrapper/bin/dftstream"), [
    "run", "-orca", join(HERE, "fake-orca.sh"), "-orbitals", "none", "-sysinterval", "2s",
    "-exp", RUN.exp, "-name", RUN.name, "-tracker-url", `convex+${CONVEX}`, inp,
  ], { FAKE_ORCA_SRC: RUN.source, FAKE_ORCA_SCF_DELAY: "0.02", FAKE_ORCA_CYCLE_DELAY: "1.1" }, join(logs, "gif-run.log"));

  const e = await waitFor("experiment", () => q("experiments:getByName", { name: RUN.exp }));
  const runDoc = await waitFor("run", () => q("runs:findByExperimentAndName", { experimentId: e._id, name: RUN.name }));
  const runPath = `/experiments/${e._id}/runs/${runDoc._id}`;
  console.log(`  run page ${runPath}`);

  const browser = await launch();
  const errors: string[] = [];
  try {
    const rec = await newPage(browser, errors, GIF.width, GIF.height, 1);
    await rec.goto(`${UI}${runPath}?tab=ts`, { waitUntil: "networkidle" });
    // Wait for the first geometry, then bring the trajectory section to the top.
    await rec.getByText("Optimization trajectory", { exact: false }).first().waitFor({ timeout: 60_000 });
    const scrollToTrajectory = async (): Promise<void> => {
      await rec.getByText("Optimization trajectory", { exact: false }).first().evaluate((el) => {
        const y = el.getBoundingClientRect().top + window.scrollY - 24;
        document.querySelector("main")?.scrollTo?.({ top: y });
        window.scrollTo({ top: y });
      });
    };
    await scrollToTrajectory();
    await rec.mouse.move(5, 5);

    const frames: Buffer[] = [];
    const end = Date.now() + GIF.maxSeconds * 1000;
    while (Date.now() < end && run.exitCode === null) {
      frames.push(await rec.screenshot());
      await rec.waitForTimeout(GIF.frameMs);
    }
    await rec.waitForTimeout(2500);
    await scrollToTrajectory();
    frames.push(await rec.screenshot());
    await writeGif(frames, join(OUT, "live-run.gif"), GIF.playMs);
  } finally {
    await browser.close();
  }
  if (run.exitCode === null) await new Promise((r) => run.on("exit", r));
  if (errors.length) {
    console.error(`\n${errors.length} page error(s):`);
    for (const err of errors) console.error(`  ! ${err}`);
  }
}

await main();
