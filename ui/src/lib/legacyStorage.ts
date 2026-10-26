import { STORAGE_KEYS } from "./storageKeys";

// Before the project was renamed from OrcaStream every key was prefixed
// "orcastream-" instead of "dftstream-". Each one is copied to its new name
// once and then dropped, so a returning user keeps their settings.
const PREFIX = "dftstream-";
const LEGACY_PREFIX = "orcastream-";

export function migrateLegacyStorageKeys(storage: Storage): void {
  for (const key of Object.values(STORAGE_KEYS)) {
    const legacyKey = LEGACY_PREFIX + key.slice(PREFIX.length);
    try {
      const value = storage.getItem(legacyKey);
      if (value === null) continue;
      if (storage.getItem(key) === null) storage.setItem(key, value);
      storage.removeItem(legacyKey);
    } catch (err) {
      // Storage refused the read or write: the app runs on defaults for this key.
      console.warn(`could not migrate ${legacyKey}:`, err);
    }
  }
}
