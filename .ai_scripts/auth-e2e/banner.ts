/**
 * Mismatch banner probe (matrix 2): load OS_UI_URL and report the
 * auth-mode banner text and whether a login form is shown.
 *   EXPECT=isolation|signin|none bun banner.ts
 */
import { UI, launch, newPage, shot, check } from "./lib";
const expect = process.env.EXPECT ?? "none";
const browser = await launch();
const { page, errors } = await newPage(await browser.newContext());
await page.goto(UI + "/experiments");
await page.waitForTimeout(4000);
const banner = page.locator(".auth-mode-banner");
const text = (await banner.count()) ? await banner.innerText() : "";
console.log("banner:", JSON.stringify(text));
console.log("login form:", await page.getByRole("button", { name: /^Sign in$/ }).count() > 0);
if (expect === "isolation") check(/Org isolation is OFF/.test(text), "isolation-OFF banner shown");
if (expect === "signin") check(/requires sign-in/.test(text), "requires-sign-in banner shown");
if (expect === "none") check(text === "", "no banner");
await shot(page, `banner-${expect}`);
console.log("console errors:", errors.length ? errors : "none");
await browser.close();
