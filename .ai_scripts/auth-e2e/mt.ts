/**
 * Matrix 11: mint / revoke a machine token in Settings → Machine tokens.
 *   STEP=create PROFILE=a ORG=e2e-org-a NAME=… TOKEN_OUT=… bun mt.ts
 *   STEP=revoke PROFILE=a ORG=e2e-org-a NAME=… bun mt.ts
 */
import { writeFileSync } from "node:fs";
import { UI, persistent, newPage, selectOrg, shot, check, confirmDialog } from "./lib";

const { STEP, ORG, NAME } = process.env as Record<string, string>;
const { ctx, close } = await persistent(process.env.PROFILE ?? "a");
const { page, errors } = await newPage(ctx);
await page.goto(UI + "/experiments");
await page.getByLabel("Active organization").waitFor();
await selectOrg(page, ORG);
await page.goto(UI + "/settings");
await page.getByText("Machine tokens", { exact: true }).waitFor();
if (STEP === "create") {
  await page.getByLabel("New machine token name").fill(NAME);
  await page.getByRole("button", { name: "Create token" }).click();
  await page.getByText(/it will not be shown again/).waitFor();
  const secret = (await page.locator("code", { hasText: /^ost_/ }).first().innerText()).trim();
  writeFileSync(process.env.TOKEN_OUT!, secret, { mode: 0o600 });
  check(secret.startsWith("ost_"), "token revealed once (ost_…)");
  await page.getByRole("button", { name: "Done" }).click();
  check(await page.locator("code", { hasText: /^ost_/ }).count() === 0, "secret gone after Done");
  check(await page.locator(".org-member-list li", { hasText: NAME }).count() === 1, "token listed by name");
} else {
  const row = page.locator(".org-member-list li", { hasText: NAME });
  await row.getByTitle("Revoke").click();
  await page.getByText("Revoke machine token?").waitFor();
  await confirmDialog(page);
  await row.getByText("revoked").waitFor();
  check(true, `${NAME} shows as revoked`);
}
await shot(page, `mt-${STEP}`);
console.log("console errors:", errors.length ? errors : "none");
await close();
