/**
 * Matrix 9: A removes B from e2e-org-a (STEP=remove) while B's browser is
 * open on org A — B must lose access at once; or re-adds B through the
 * confirmation flow (STEP=readd).
 */
import { UI, persistent, newPage, selectOrg, shot, check, confirmDialog, activeOrgLabel } from "./lib";

const step = process.env.STEP ?? "remove";
const a = await persistent("a");
const { page: pa } = await newPage(a.ctx);
await pa.goto(UI + "/experiments");
await pa.getByLabel("Active organization").waitFor();
await selectOrg(pa, "e2e-org-a");
await pa.goto(UI + "/settings");
await pa.getByText(/you are owner/).waitFor();

if (step === "remove") {
  const b = await persistent("b");
  const { page: pb, errors: eb } = await newPage(b.ctx);
  await pb.goto(UI + "/experiments");
  await pb.getByLabel("Active organization").waitFor();
  await selectOrg(pb, "e2e-org-a");
  await pb.getByText("e2e-exp-a").first().waitFor();
  check(true, "B's browser shows org A's experiments before removal");

  const row = pa.locator(".org-member-list li", { hasText: "e2e-b@example.test" });
  await row.getByTitle("Remove").click();
  await pa.getByText("Remove member?").waitFor();
  await confirmDialog(pa);
  await row.waitFor({ state: "detached" });
  const t0 = Date.now();
  // Reactive: no reload on B's side.
  await pb.waitForFunction(() => !document.body.innerText.includes("e2e-exp-a"), undefined, { timeout: 15_000 });
  check(true, `B's open page dropped org A's data without a reload (${Date.now() - t0} ms)`);
  const opts = await pb.locator(".org-select option").allTextContents();
  check(!opts.some((o) => o.includes("e2e-org-a")), `org A gone from B's switcher (${opts.join(" | ")}); active: ${await activeOrgLabel(pb)}`);
  await shot(pb, "offboard-b-after");
  console.log("B console errors:", eb.length ? eb.map((e) => e.slice(0, 120)) : "none");
  await b.close();
} else {
  await pa.getByLabel("Member email").fill("e2e-b@example.test");
  await pa.getByLabel("New member role").selectOption("member");
  await pa.locator(".settings-row", { has: pa.getByLabel("Member email") }).getByRole("button", { name: "Add", exact: true }).click();
  await pa.getByRole("button", { name: "Grant member to this account" }).click();
  await pa.locator(".org-member-list li", { hasText: "e2e-b@example.test" }).waitFor();
  check(true, "B re-added as member");
}
await a.close();
