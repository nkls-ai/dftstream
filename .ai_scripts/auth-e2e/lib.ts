/**
 * Shared helpers for the live auth end-to-end scripts. Headless Chromium from
 * the playwright cache, driven against the LOCAL backend only.
 *
 * Needs LD_LIBRARY_PATH=~/.cache/orbital-chrome-libs (see
 * ../readme-screenshots/env.sh). Point E2E_OUT / E2E_BROWSER_DIR and every
 * cli.sh call's E2E_ROOT at a scratch dir — never the real ~/.config.
 *
 * Order used for the v1 auth matrix (each script documents its env):
 *   baseline.ts (auth off) → banner.ts → setenv.sh DFTSTREAM_AUTH_REQUIRED 1
 *   (+ SITE_URL) → a-setup.ts → cli.sh login + approve.ts → fakerun.sh
 *   --org → shared.ts → api-probe.ts → roles.ts (invite, signup-c,
 *   confirm-c, b-sees, token) → perms.ts → roles.ts (admin-ui, self-demote,
 *   switch) → expire-access.ts + parallel fakerun.sh → mt.ts → offboard.ts
 *   → deleteorg.ts → clerk-probe.ts → restore env → baseline.ts again.
 * proxy.ts sits between the CLI and Convex to record Authorization headers.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "../readme-screenshots/node_modules/playwright-core";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const UI = process.env.OS_UI_URL ?? "http://127.0.0.1:3300";
export const CONVEX = process.env.OS_CONVEX_URL ?? "http://127.0.0.1:3210";
export const CONVEX_SITE = process.env.OS_CONVEX_SITE_URL ?? "http://127.0.0.1:3211";
export const OUT = process.env.E2E_OUT ?? join(import.meta.dir, "out");
const EXEC = `${homedir()}/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell`;

if (!CONVEX.startsWith("http://127.0.0.1") && !CONVEX.startsWith("http://localhost")) {
  throw new Error(`refusing to run against a non-local backend: ${CONVEX}`);
}

export async function launch(): Promise<Browser> {
  mkdirSync(OUT, { recursive: true });
  return chromium.launch({ executablePath: EXEC, args: ["--no-sandbox"] });
}

/** A page that records console errors and failed requests for the evidence log. */
export async function newPage(ctx: BrowserContext): Promise<{ page: Page; errors: string[] }> {
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message.slice(0, 300)));
  return { page, errors };
}

export async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false });
}

export function check(cond: unknown, what: string): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${what}`);
  if (!cond) process.exitCode = 1;
}

/** Sign up (or in) through the PasswordLoginForm. */
export async function passwordAuth(page: Page, mode: "signUp" | "signIn", email: string, password: string, name?: string): Promise<void> {
  await page.goto(UI + "/experiments");
  await page.getByRole("button", { name: /^Sign in$/ }).waitFor();
  if (mode === "signUp") {
    await page.getByRole("button", { name: /Need an account\? Sign up/ }).click();
    if (name) await page.getByLabel("Username").fill(name);
  }
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: mode === "signUp" ? /^Sign up$/ : /^Sign in$/ }).click();
  await page.getByRole("button", { name: /^Sign (in|up)$/ }).waitFor({ state: "detached", timeout: 20_000 });
}

/** The convex-auth access JWT the UI holds (localStorage), for direct API probes. */
export async function convexAuthJwt(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (k.startsWith("__convexAuthJWT")) return localStorage.getItem(k);
    }
    return null;
  });
}

/** Call a public Convex function over HTTP as `token` (null = anonymous). */
export async function convexCall(kind: "query" | "mutation" | "action", path: string, args: unknown, token: string | null): Promise<{ status: string; value?: unknown; errorMessage?: string }> {
  const res = await fetch(`${CONVEX}/api/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  return (await res.json()) as { status: string; value?: unknown; errorMessage?: string };
}

export async function localStorageDump(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const o: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i)!; o[k] = (localStorage.getItem(k) ?? "").slice(0, 80); }
    return o;
  });
}

/** A browser profile that persists across scripts (one per simulated person/browser). */
export async function persistent(name: string): Promise<{ ctx: BrowserContext; close(): Promise<void> }> {
  const dir = join(process.env.E2E_BROWSER_DIR ?? join(OUT, "browsers"), name);
  mkdirSync(dir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(dir, {
    executablePath: EXEC, args: ["--no-sandbox"], viewport: { width: 1400, height: 900 },
  });
  return { ctx, close: () => ctx.close() };
}

/** Whether the page currently shows the password login form. */
export async function onLogin(page: Page): Promise<boolean> {
  return (await page.getByRole("button", { name: /^Sign (in|up)$/ }).count()) > 0;
}

/** Create an org through the sidebar select + prompt dialog. */
export async function createOrg(page: Page, name: string): Promise<void> {
  const sel = page.getByLabel("Active organization");
  await sel.waitFor();
  await sel.selectOption({ label: "+ New organization…" });
  await page.locator(".dialog-input").fill(name);
  await page.locator(".dialog-btn.primary").click();
  await page.locator(".org-select option", { hasText: name }).first().waitFor({ state: "attached" });
}

export async function selectOrg(page: Page, name: string): Promise<void> {
  const sel = page.getByLabel("Active organization");
  const opt = page.locator(".org-select option", { hasText: name }).first();
  await opt.waitFor({ state: "attached" });
  await sel.selectOption(await opt.getAttribute("value") as string);
}

/** Selected org label in the sidebar. */
export async function activeOrgLabel(page: Page): Promise<string> {
  return page.getByLabel("Active organization").evaluate((s: HTMLSelectElement) => s.selectedOptions[0]?.textContent ?? "");
}

export async function confirmDialog(page: Page): Promise<void> {
  await page.locator(".dialog-btn.primary").click();
}
