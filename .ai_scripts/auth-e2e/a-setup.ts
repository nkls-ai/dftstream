/**
 * Matrix 4 (part 1): user A signs up in their own browser profile and creates
 * org e2e-org-a. Prints A's convex-auth JWT for direct-API probes to a file.
 */
import { writeFileSync } from "node:fs";
import { UI, persistent, newPage, passwordAuth, createOrg, activeOrgLabel, convexAuthJwt, shot, check, onLogin } from "./lib";

const { ctx, close } = await persistent("a");
const { page, errors } = await newPage(ctx);
await page.goto(UI + "/experiments");
await page.waitForTimeout(2000);
if (await onLogin(page)) await passwordAuth(page, "signUp", "e2e-a@example.test", "e2e-pass-A1", "e2e-a");
check(!(await onLogin(page)), "A signed up and past the gate");
await page.getByLabel("Active organization").waitFor();
if ((await page.locator(".org-select option", { hasText: "e2e-org-a" }).count()) === 0) await createOrg(page, "e2e-org-a");
await page.waitForTimeout(1000);
check((await activeOrgLabel(page)).startsWith("e2e-org-a"), `active org is e2e-org-a (${await activeOrgLabel(page)})`);
check(await page.getByText("organoselenium-radical-ts").count() === 0, "A sees none of the legacy (org-less) experiments");
await shot(page, "a-setup");
writeFileSync(process.env.TOKEN_OUT ?? "/dev/null", (await convexAuthJwt(page)) ?? "", { mode: 0o600 });
console.log("console errors:", errors.length ? errors : "none");
await close();
