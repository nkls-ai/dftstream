import type { StorageKey } from "./storageKeys";

// One place for the localStorage + JSON dance every persisted store repeats.
// localStorage can throw (private browsing, disabled storage, quota) and a
// stored blob can be corrupted by an older build or a hand edit, so both
// helpers degrade instead of throwing: callers keep their in-memory state.

/**
 * The parsed JSON under `key`, or undefined when the key is absent, storage
 * is unavailable, or the blob does not parse. Callers validate the shape.
 */
export function readJson(key: StorageKey): unknown {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch { /* storage unavailable (private browsing / disabled): treat as absent */
    return undefined;
  }
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch { /* corrupted blob: treat as absent; the next write replaces it */
    return undefined;
  }
}

/** Serialises `value` under `key`. False when storage refused the write. */
export function writeJson(key: StorageKey, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch { /* storage full or disabled: persistence is best-effort, the caller keeps its in-memory state */
    return false;
  }
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
