/**
 * Approve an `dftstream login` in the browser profile PROFILE by TYPING the
 * code (CODE, any case/dash form) on /cli-link — not following the link —
 * for org ORG. Matrix 6.
 */
import { UI, persistent, newPage, selectOrg, shot, check } from "./lib";

const profile = process.env.PROFILE ?? "a";
const code = process.env.CODE!;
const org = process.env.ORG!;
const { ctx, close } = await persistent(profile);
const { page, errors } = await newPage(ctx);
await page.goto(UI + "/cli-link");
const panel = page.locator(".cli-link-panel");
await panel.getByLabel("Code").fill(code);
const orgSel = panel.getByLabel("Organization");
const val = await orgSel.locator("option", { hasText: org }).first().getAttribute("value");
await orgSel.selectOption(val!);
await panel.getByRole("button", { name: "Approve" }).click();
await page.getByText("CLI connected").waitFor();
const text = await page.locator(".empty-state").innerText();
check(text.includes(org), `approval screen names the org: ${JSON.stringify(text.slice(0, 120))}`);
await shot(page, `approve-${profile}`);
console.log("console errors:", errors.length ? errors : "none");
await close();
