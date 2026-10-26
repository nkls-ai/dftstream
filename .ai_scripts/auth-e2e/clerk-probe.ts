/** Matrix 14: the clerk adapter mounts with a dummy key and gets as far as the network. */
import { launch, newPage, shot, check } from "./lib";
const UI = process.env.OS_UI_URL!;
const browser = await launch();
const ctx = await browser.newContext();
const { page, errors } = await newPage(ctx);
const hosts = new Set<string>();
page.on("request", (r) => { const h = new URL(r.url()).host; if (!h.startsWith("127.0.0.1")) hosts.add(h); });
await page.goto(UI + "/experiments");
await page.waitForTimeout(6000);
const body = await page.locator("body").innerText();
console.log("external hosts requested:", [...hosts]);
console.log("page text:", JSON.stringify(body.slice(0, 200)));
check([...hosts].some((h) => h.includes("clerk")), "clerk adapter mounted (Clerk frontend API requested)");
check(!/Unknown auth provider|not a valid auth provider/i.test(body), "no auth-config error screen");
await shot(page, "clerk-dummy");
console.log("console errors:", errors.map((e) => e.slice(0, 160)));
await browser.close();
