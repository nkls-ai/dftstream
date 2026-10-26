/** Matrix 10 / cleanup: the owner deletes ORG from Settings (PROFILE's browser). */
import { UI, persistent, newPage, selectOrg, check, confirmDialog } from "./lib";

const { ORG } = process.env as Record<string, string>;
const { ctx, close } = await persistent(process.env.PROFILE ?? "b");
const { page, errors } = await newPage(ctx);
await page.goto(UI + "/experiments");
await page.getByLabel("Active organization").waitFor();
await selectOrg(page, ORG);
await page.goto(UI + "/settings");
await page.getByText(/you are owner/).waitFor();
await page.getByRole("button", { name: "Delete organization" }).click();
await page.getByText("Delete organization?").waitFor();
await confirmDialog(page);
await page.locator(".org-select option", { hasText: ORG }).waitFor({ state: "detached", timeout: 15_000 });
check(true, `${ORG} deleted and gone from the switcher`);
console.log("console errors:", errors.length ? errors.map((e) => e.slice(0, 160)) : "none");
await close();
