import { expect, test } from "bun:test";
import { migrateLegacyStorageKeys } from "./legacyStorage";
import { STORAGE_KEYS } from "./storageKeys";

function memoryStorage(initial: Record<string, string>): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => { map.delete(k); },
    setItem: (k, v) => { map.set(k, v); },
  };
}

test("every key uses the prefix the migration strips", () => {
  for (const key of Object.values(STORAGE_KEYS)) expect(key.startsWith("dftstream-")).toBe(true);
});

test("copies a pre-rename key and drops the old one", () => {
  const s = memoryStorage({ "orcastream-settings": '{"theme":"light"}' });
  migrateLegacyStorageKeys(s);
  expect(s.getItem(STORAGE_KEYS.settings)).toBe('{"theme":"light"}');
  expect(s.getItem("orcastream-settings")).toBeNull();
});

test("never overwrites a value already stored under the new name", () => {
  const s = memoryStorage({ "orcastream-settings": "old", "dftstream-settings": "new" });
  migrateLegacyStorageKeys(s);
  expect(s.getItem(STORAGE_KEYS.settings)).toBe("new");
  expect(s.getItem("orcastream-settings")).toBeNull();
});
