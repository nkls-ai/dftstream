import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AuthProviderKind, parseAuthProviderKind } from "./providerKind";
import { AUTH_ADAPTERS, getAuthAdapter } from "./registry";
import { clearPerUserState } from "./perUserState";
import { wrapSignOut } from "./AuthSession";
import { clerkTokenOptions } from "./adapters/clerkToken";
import { STORAGE_KEYS } from "../lib/storageKeys";
import { compareBasketToggle } from "../lib/compareBasket";
import { readJson } from "../lib/persistedJson";

describe("parseAuthProviderKind", () => {
  test("empty / absent / whitespace means no auth, exactly as before", () => {
    for (const raw of [undefined, null, "", "   "]) {
      expect(parseAuthProviderKind(raw)).toEqual({ ok: true, kind: AuthProviderKind.NONE });
    }
  });

  test("known providers parse to their kind", () => {
    expect(parseAuthProviderKind("convex")).toEqual({ ok: true, kind: AuthProviderKind.CONVEX });
    expect(parseAuthProviderKind(" clerk ")).toEqual({ ok: true, kind: AuthProviderKind.CLERK });
  });

  test("an unknown value is an error, never a silent no-auth fallback", () => {
    expect(parseAuthProviderKind("Clerk")).toEqual({ ok: false, raw: "Clerk" });
    expect(parseAuthProviderKind("auth0")).toEqual({ ok: false, raw: "auth0" });
  });
});

describe("adapter registry", () => {
  test("every kind has an adapter that reports that kind", () => {
    for (const kind of Object.values(AuthProviderKind)) {
      expect(getAuthAdapter(kind).kind).toBe(kind);
    }
    expect(Object.keys(AUTH_ADAPTERS).sort()).toEqual(Object.values(AuthProviderKind).sort());
  });

  test("only NONE is ungated; only convex-auth offers the password form", () => {
    expect(getAuthAdapter(AuthProviderKind.NONE).gated).toBe(false);
    expect(getAuthAdapter(AuthProviderKind.CONVEX).gated).toBe(true);
    expect(getAuthAdapter(AuthProviderKind.CLERK).gated).toBe(true);
    expect(getAuthAdapter(AuthProviderKind.CONVEX).capabilities.supportsPassword).toBe(true);
    expect(getAuthAdapter(AuthProviderKind.CLERK).capabilities.supportsPassword).toBe(false);
  });
});

describe("clerkTokenOptions (mirrors ConvexProviderWithClerk)", () => {
  test("native Convex integration: session token already has aud=convex, no template", () => {
    expect(clerkTokenOptions("convex")).toEqual({});
  });
  test("template setup: ask for the convex JWT template", () => {
    expect(clerkTokenOptions(undefined)).toEqual({ template: "convex" });
    expect(clerkTokenOptions("https://example.com")).toEqual({ template: "convex" });
  });
});

describe("sign-out clears per-user state", () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  test("clearPerUserState drops org, basket and notification watermark but keeps prefs", () => {
    store.set(STORAGE_KEYS.activeOrg, "org_a");
    store.set(STORAGE_KEYS.notificationsSeen, "123");
    store.set(STORAGE_KEYS.settings, '{"theme":"dark"}');
    compareBasketToggle("run_1");
    expect(readJson(STORAGE_KEYS.compareBasket)).toEqual(["run_1"]);

    clearPerUserState();

    expect(store.has(STORAGE_KEYS.activeOrg)).toBe(false);
    expect(store.has(STORAGE_KEYS.notificationsSeen)).toBe(false);
    expect(store.has(STORAGE_KEYS.compareBasket)).toBe(false);
    expect(store.get(STORAGE_KEYS.settings)).toBe('{"theme":"dark"}');
    // The in-memory basket mirror is reset too, not just storage.
    compareBasketToggle("run_2");
    expect(readJson(STORAGE_KEYS.compareBasket)).toEqual(["run_2"]);
  });

  test("clearPerUserState tolerates a throwing storage", () => {
    const throwing = { removeItem: () => { throw new Error("blocked"); } };
    expect(() => clearPerUserState(throwing)).not.toThrow();
  });

  test("wrapSignOut clears only after the provider sign-out succeeds", async () => {
    const calls: string[] = [];
    await wrapSignOut(async () => void calls.push("provider"), () => calls.push("clear"))();
    expect(calls).toEqual(["provider", "clear"]);

    const failed: string[] = [];
    const signOut = wrapSignOut(async () => { throw new Error("network"); }, () => failed.push("clear"));
    await expect(signOut()).rejects.toThrow("network");
    expect(failed).toEqual([]);
  });
});
