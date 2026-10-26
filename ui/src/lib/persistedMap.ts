import { isPlainObject, readJson, writeJson } from "./persistedJson";
import type { StorageKey } from "./storageKeys";

// A localStorage key holding a JSON object of id -> entry (per-table sort,
// per-section disclosure, per-table column prefs). A corrupted or
// wrong-shaped blob reads as empty and is replaced wholesale by the next
// write, so one bad blob can never block persistence forever.

function readMap(key: StorageKey): Record<string, unknown> {
  const parsed = readJson(key);
  return isPlainObject(parsed) ? parsed : {};
}

/** The raw entry for `id` (undefined when absent); callers validate its shape. */
export function readMapEntry(key: StorageKey, id: string): unknown {
  return readMap(key)[id];
}

/** Sets the entry for `id`, or removes it when `value` is undefined. False when storage refused. */
export function writeMapEntry(key: StorageKey, id: string, value: unknown): boolean {
  const map = readMap(key);
  if (value === undefined) delete map[id];
  else map[id] = value;
  return writeJson(key, map);
}
