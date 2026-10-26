/**
 * Matrix 5 (roles & invites) and 12 (org settings UI), in STEPs so a person's
 * browser profile persists between them:
 *
 *   STEP=invite     A: pending invite for C (no account), confirm-grant B as member
 *   STEP=signup-c   C signs up → no org (sign-up never redeems an invite)
 *   STEP=confirm-c  A: re-add C as viewer → needs-confirmation names the late account → grant
 *   STEP=b-sees     B: org A appears, A's experiment visible
 *   STEP=token      PROFILE's JWT → TOKEN_OUT
 *   STEP=admin-ui   B (admin): no owner controls in org settings
 *   STEP=self-demote A: lowering own role asks to confirm; last owner refused
 *   STEP=switch     B: invite review + token reveal are cleared by an org switch
 */
import { writeFileSync } from "node:fs";
import { UI, persistent, newPage, passwordAuth, convexAuthJwt, selectOrg, shot, check, onLogin, confirmDialog } from "./lib";
import type { Page } from "../readme-screenshots/node_modules/playwright-core";

const step = process.env.STEP!;
const USERS: Record<string, [string, string]> = {
  a: ["e2e-a@example.test", "e2e-pass-A1"], b: ["e2e-b@example.test", "e2e-pass-B1"], c: ["e2e-c@example.test", "e2e-pass-C1"],
};
const profile = process.env.PROFILE ?? { invite: "a", "signup-c": "c", "confirm-c": "a", "b-sees": "b", "admin-ui": "b", "self-demote": "a", switch: "b" }[step] ?? "a";
const { ctx, close } = await persistent(profile);
const { page, errors } = await newPage(ctx);

async function signedIn(p: Page, who: string, signUp = false) {
  await p.goto(UI + "/experiments");
  await p.waitForTimeout(1500);
  if (await onLogin(p)) await passwordAuth(p, signUp ? "signUp" : "signIn", USERS[who]![0], USERS[who]![1], `e2e-${who}`);
  await p.getByLabel("Active organization").waitFor();
}
async function addMember(p: Page, email: string, role: string) {
  await p.getByLabel("Member email").fill(email);
  await p.getByLabel("New member role").selectOption(role);
  await p.locator(".settings-row", { has: p.getByLabel("Member email") }).getByRole("button", { name: "Add", exact: true }).click();
}
async function settingsFor(p: Page, org: string) {
  await selectOrg(p, org);
  await p.goto(UI + "/settings");
  await p.getByText("Organization", { exact: true }).waitFor();
}

switch (step) {
  case "invite": {
    await signedIn(page, "a");
    await settingsFor(page, "e2e-org-a");
    await addMember(page, "e2e-c@example.test", "viewer");
    await page.getByText(/No account exists for e2e-c@example.test yet/).waitFor();
    check(true, "invite for an unknown email is recorded as pending, grants nothing");
    await addMember(page, "e2e-b@example.test", "member");
    await page.getByText(/An account matches e2e-b@example.test/).waitFor();
    check(true, "existing self-asserted account → needs admin confirmation");
    await shot(page, "invite-confirm-b");
    await page.getByRole("button", { name: "Grant member to this account" }).click();
    await page.locator(".org-member-list li", { hasText: "e2e-b@example.test" }).waitFor();
    check(true, "B granted member after confirmation");
    break;
  }
  case "signup-c": {
    await signedIn(page, "c", true);
    await page.waitForTimeout(2000);
    const opts = await page.locator(".org-select option").allTextContents();
    check(!opts.some((o) => o.includes("e2e-org-a")), `sign-up does not redeem the pending invite (orgs: ${opts.join(" | ")})`);
    break;
  }
  case "confirm-c": {
    await signedIn(page, "a");
    await settingsFor(page, "e2e-org-a");
    await addMember(page, "e2e-c@example.test", "viewer");
    await page.getByText(/An account matches e2e-c@example.test/).waitFor();
    check(await page.getByText("This account was created after the invite was sent.").count() === 1, "review flags the account as created after the invite");
    await shot(page, "invite-confirm-c");
    await page.getByRole("button", { name: "Grant viewer to this account" }).click();
    await page.locator(".org-member-list li", { hasText: "e2e-c@example.test" }).waitFor();
    check(true, "C granted viewer");
    break;
  }
  case "b-sees": {
    await signedIn(page, "b");
    await selectOrg(page, "e2e-org-a");
    await page.goto(UI + "/experiments");
    await page.getByText("e2e-exp-a").first().waitFor();
    check(true, "B (member) now sees org A's experiment");
    break;
  }
  case "token": {
    await signedIn(page, profile);
    writeFileSync(process.env.TOKEN_OUT!, (await convexAuthJwt(page)) ?? "", { mode: 0o600 });
    check(true, `token for ${profile} written`);
    break;
  }
  case "admin-ui": {
    await signedIn(page, "b");
    await settingsFor(page, "e2e-org-a");
    await page.getByText(/you are admin/).waitFor();
    check(await page.getByRole("button", { name: "Delete organization" }).count() === 0, "admin: no Delete organization");
    const ownerRow = page.locator(".org-member-list li", { hasText: "e2e-a@example.test" });
    check(await ownerRow.locator("select").count() === 0, "admin: owner's role is not editable");
    check(await ownerRow.getByTitle("Remove").count() === 0, "admin: owner cannot be removed");
    const opts = await page.getByLabel("New member role").locator("option").allTextContents();
    check(!opts.includes("owner"), `admin: cannot invite as owner (roles: ${opts.join(",")})`);
    await shot(page, "admin-settings");
    break;
  }
  case "self-demote": {
    await signedIn(page, "a");
    await settingsFor(page, "e2e-org-a");
    const self = page.getByLabel("Role for e2e-a@example.test");
    await self.selectOption("admin");
    await page.getByText("Lower your own role?").waitFor();
    check(true, "self-demotion asks for confirmation");
    await confirmDialog(page);
    await page.waitForTimeout(1500);
    const text = await page.locator("body").innerText();
    check(/owner/i.test(text) && (await page.locator(".dialog-card").count()) > 0, "last-owner demotion refused with a visible error");
    console.log("dialog:", (await page.locator(".dialog-card").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 200));
    await shot(page, "self-demote");
    if (await page.locator(".dialog-card").count()) await page.locator(".dialog-btn.primary").click();
    await page.waitForTimeout(500);
    check((await page.getByText(/you are owner/).count()) === 1, "A is still owner");
    break;
  }
  case "switch": {
    // B is owner of e2e-org-b and admin of e2e-org-a. Open an invite review
    // and a one-time token reveal in org B, then switch to org A.
    await signedIn(page, "b");
    await settingsFor(page, "e2e-org-b");
    await addMember(page, "e2e-a@example.test", "member");
    await page.getByText(/An account matches e2e-a@example.test/).waitFor();
    await page.getByLabel("New machine token name").fill("e2e-switch-token");
    await page.getByRole("button", { name: "Create token" }).click();
    await page.getByText(/it will not be shown again/).waitFor();
    const secret = (await page.locator("code", { hasText: /^ost_/ }).first().innerText()).trim();
    writeFileSync(process.env.TOKEN_OUT ?? "/dev/null", secret, { mode: 0o600 });
    check(true, "invite review + token reveal open in e2e-org-b");
    await selectOrg(page, "e2e-org-a");
    await page.getByText(/you are admin/).waitFor();
    await page.waitForTimeout(800);
    check(await page.getByText(/An account matches/).count() === 0, "switch to e2e-org-a cleared the invite review");
    check(await page.getByText(/it will not be shown again/).count() === 0, "switch cleared the token reveal");
    check(await page.locator("code", { hasText: /^ost_/ }).count() === 0, "no secret left on screen");
    await selectOrg(page, "e2e-org-b");
    await page.getByText(/you are owner/).waitFor();
    await page.waitForTimeout(800);
    check(await page.getByText(/An account matches|it will not be shown again/).count() === 0, "switching back does not resurrect either");
    await shot(page, "switch-cleared");
    break;
  }
}
console.log("console errors:", errors.length ? errors.map((e) => e.slice(0, 140)) : "none");
await close();
