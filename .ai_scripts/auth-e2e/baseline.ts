/**
 * Auth-OFF baseline (matrix 1 / 15): UI without provider, backend without
 * enforcement → no login gate, no mismatch banner, the user's experiments are
 * listed, an artifact body streams, and the Tools tab loads a local file.
 *
 *   BASE_EXP=<expId> BASE_RUN=<runId> LOCAL_XYZ=/abs/file.xyz bun baseline.ts
 */
import { UI, launch, newPage, shot, check } from "./lib";

const EXP = process.env.BASE_EXP!;
const RUN = process.env.BASE_RUN!;
const XYZ = process.env.LOCAL_XYZ!;
const TAG = process.env.TAG ?? "baseline";

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const { page, errors } = await newPage(ctx);

await page.goto(UI + "/experiments");
await page.getByText("organoselenium-radical-ts").first().waitFor();
check(await page.getByRole("button", { name: /^Sign in$/ }).count() === 0, "no login gate");
check(await page.locator(".auth-mode-banner").count() === 0, "no auth-mode banner");
check(await page.getByText("hcn-hnc-isomerization-neb").count() > 0, "existing experiments listed");
await shot(page, `${TAG}-experiments`);

// Artifact body through /api/artifact.
const bodyReqs: number[] = [];
page.on("response", (r) => { if (r.url().includes("/api/artifact")) bodyReqs.push(r.status()); });
await page.goto(`${UI}/experiments/${EXP}/runs/${RUN}?tab=artifacts`);
await page.locator(".art-flat-list li, .art-flat-list button").first().waitFor();
// property.txt is storage-backed (inline bodies never hit /api/artifact).
const body = page.waitForResponse((r) => r.url().includes("/api/artifact"));
await page.locator(".art-flat-list").getByText(/property\.txt$/).first().click();
await body;
await page.getByText(/Calculation_Status/).first().waitFor({ timeout: 20_000 });
check(bodyReqs.includes(200), `artifact body fetched via /api/artifact (statuses ${bodyReqs.join(",")})`);
await shot(page, `${TAG}-artifact`);

// Tools tab: local file via /api/local-file.
await page.goto(UI + "/tools");
await page.getByLabel("Absolute file path on the machine running dftstream").fill(XYZ);
const lf = page.waitForResponse((r) => r.url().includes("/api/local-file"));
await page.getByRole("button", { name: "Load" }).click();
const lfRes = await lf;
check(lfRes.status() === 200, `Tools tab /api/local-file → ${lfRes.status()}`);
await page.getByText("live-follow").waitFor();
await shot(page, `${TAG}-tools`);

console.log("console errors:", errors.length ? errors : "none");
await browser.close();
