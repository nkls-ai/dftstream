import { afterEach, beforeEach, expect, test } from "bun:test";
import { loadDisclosure, storeDisclosure } from "./usePersistedDisclosure";
import { STORAGE_KEYS } from "../lib/storageKeys";

function stubLocalStorage() {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  return store;
}

let store: Map<string, string>;

beforeEach(() => {
  store = stubLocalStorage();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).localStorage;
});

test("returns null when nothing stored", () => {
  expect(loadDisclosure("run.overview.irSpectrum")).toBeNull();
});

test("round-trips open state per section key", () => {
  storeDisclosure("a", true);
  storeDisclosure("b", false);
  expect(loadDisclosure("a")).toBe(true);
  expect(loadDisclosure("b")).toBe(false);
  expect(loadDisclosure("c")).toBeNull();
});

test("ignores corrupted JSON", () => {
  store.set(STORAGE_KEYS.sectionOpen, "{not json");
  expect(loadDisclosure("a")).toBeNull();
  storeDisclosure("a", true);
  expect(loadDisclosure("a")).toBe(true);
});

test("ignores non-boolean entries", () => {
  store.set(STORAGE_KEYS.sectionOpen, JSON.stringify({ a: "yes" }));
  expect(loadDisclosure("a")).toBeNull();
});
