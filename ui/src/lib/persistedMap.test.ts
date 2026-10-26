import { afterEach, beforeEach, expect, test } from "bun:test";
import { readMapEntry, writeMapEntry } from "./persistedMap";
import { readJson, writeJson } from "./persistedJson";
import { STORAGE_KEYS } from "./storageKeys";

const KEY = STORAGE_KEYS.tableSort;

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

test("readJson: absent and corrupted keys read as undefined", () => {
  expect(readJson(KEY)).toBeUndefined();
  store.set(KEY, "{not json");
  expect(readJson(KEY)).toBeUndefined();
});

test("readJson / writeJson round-trip", () => {
  expect(writeJson(KEY, { a: 1 })).toBe(true);
  expect(readJson(KEY)).toEqual({ a: 1 });
});

test("storage that throws degrades instead of throwing", () => {
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: () => { throw new Error("denied"); },
    setItem: () => { throw new Error("quota"); },
  };
  expect(readJson(KEY)).toBeUndefined();
  expect(writeJson(KEY, 1)).toBe(false);
  expect(readMapEntry(KEY, "a")).toBeUndefined();
  expect(writeMapEntry(KEY, "a", 1)).toBe(false);
});

test("map entries round-trip independently", () => {
  writeMapEntry(KEY, "a", 1);
  writeMapEntry(KEY, "b", { x: true });
  expect(readMapEntry(KEY, "a")).toBe(1);
  expect(readMapEntry(KEY, "b")).toEqual({ x: true });
  expect(readMapEntry(KEY, "c")).toBeUndefined();
});

test("writing undefined removes the entry", () => {
  writeMapEntry(KEY, "a", 1);
  writeMapEntry(KEY, "a", undefined);
  expect(JSON.parse(store.get(KEY)!)).toEqual({});
});

test("a corrupted blob is reset by the next write, not left broken", () => {
  store.set(KEY, "{not json");
  expect(readMapEntry(KEY, "a")).toBeUndefined();
  expect(writeMapEntry(KEY, "a", 1)).toBe(true);
  expect(readMapEntry(KEY, "a")).toBe(1);
});

test("a non-object blob (array / scalar) is treated as empty and replaced", () => {
  store.set(KEY, "[1,2]");
  expect(readMapEntry(KEY, "0")).toBeUndefined();
  writeMapEntry(KEY, "a", 1);
  expect(JSON.parse(store.get(KEY)!)).toEqual({ a: 1 });
});
