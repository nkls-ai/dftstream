/**
 * Matrix 4 (part 2), one shared browser: A signs in, opens a storage-backed
 * artifact of their org's run, fills the compare basket and the notification
 * watermark, signs out → per-user localStorage keys are gone. B signs up in
 * the same browser → clean state, sees none of A's data, creates e2e-org-b.
 *
 *   A_EXP=… A_RUN=… A_ART_NAME=stdout.out TOKEN_OUT_B=… bun shared.ts
 */
import { writeFileSync } from "node:fs";
import { UI, persistent, newPage, passwordAuth, createOrg, activeOrgLabel, convexAuthJwt, localStorageDump, shot, check, onLogin } from "./lib";

const PER_USER = ["dftstream-active-org", "dftstream-compare-basket", "dftstream-notifications-seen"];
const { ctx, close } = await persistent("shared");
const { page, errors } = await newPage(ctx);
await page.goto(UI + "/experiments");
await page.waitForTimeout(1500);
if (!(await onLogin(page))) throw new Error("shared profile unexpectedly signed in; wipe it first");
await passwordAuth(page, "signIn", "e2e-a@example.test", "e2e-pass-A1");
await page.getByText("e2e-exp-a").first().waitFor();

await page.goto(`${UI}/experiments/${process.env.A_EXP}/runs/${process.env.A_RUN}?tab=artifacts`);
const body = page.waitForResponse((r) => r.url().includes("/api/artifact"));
await page.locator(".art-flat-list").getByText(new RegExp(process.env.A_ART_NAME! + "$")).first().click();
const bodyRes = await body;
check(bodyRes.status() === 200, `A reads the artifact body via /api/artifact (${bodyRes.status()})`);
await page.getByRole("button", { name: /⇄ compare/ }).click();
await page.getByRole("button", { name: /^Notifications/ }).click();
await page.waitForTimeout(500);
const before = await localStorageDump(page);
check(PER_USER.every((k) => k in before), `per-user keys present before sign-out: ${PER_USER.filter((k) => k in before).join(", ")}`);

await page.getByTitle("Sign out").click();
await page.getByRole("button", { name: /^Sign in$/ }).waitFor();
const after = await localStorageDump(page);
check(PER_USER.every((k) => !(k in after)), `per-user keys cleared on sign-out (left: ${PER_USER.filter((k) => k in after).join(", ") || "none"})`);
check(!Object.keys(after).some((k) => k.startsWith("__convexAuthJWT") && after[k]), "no convex-auth JWT left in storage");

await passwordAuth(page, "signUp", "e2e-b@example.test", "e2e-pass-B1", "e2e-b");
await page.getByLabel("Active organization").waitFor();
await page.waitForTimeout(2500);
check((await activeOrgLabel(page)).includes("No organizations"), `B starts with no org (${await activeOrgLabel(page)})`);
check(await page.getByText("e2e-exp-a").count() === 0, "B's experiment list shows none of A's experiments");
check(await page.locator(".compare-basket-pill, [class*=compare-basket]").count() === 0, "no compare basket carried over");
await shot(page, "shared-b-fresh");
// A's run page, straight by URL.
await page.goto(`${UI}/experiments/${process.env.A_EXP}/runs/${process.env.A_RUN}`);
await page.waitForTimeout(3000);
check(await page.getByText("opt-freq_ma1_r2scan3c").count() === 0, "B cannot open A's run page by URL");
await shot(page, "shared-b-a-run");
await page.goto(UI + "/experiments");
await createOrg(page, "e2e-org-b");
await page.waitForTimeout(1000);
check((await activeOrgLabel(page)).startsWith("e2e-org-b"), `B created and selected e2e-org-b`);
check(await page.getByText("e2e-exp-a").count() === 0, "B in e2e-org-b still sees nothing of A's");
writeFileSync(process.env.TOKEN_OUT_B ?? "/dev/null", (await convexAuthJwt(page)) ?? "", { mode: 0o600 });
console.log("console errors:", errors.length ? errors : "none");
await close();
