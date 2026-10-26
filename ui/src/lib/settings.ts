import { useCallback, useSyncExternalStore } from "react";
import { STORAGE_KEYS } from "./storageKeys";
import { readJson, writeJson } from "./persistedJson";
import { parseSettings, type Settings, type TimeFormat } from "./settingsSchema";

export type {
  Settings,
  Theme,
  TimeFormat,
  EnergyDecimals,
  ViewerStyle,
  ExperimentPageSize,
} from "./settingsSchema";

const KEY = STORAGE_KEYS.settings;

let cached: Settings | null = null;
const listeners = new Set<() => void>();

function load(): Settings {
  if (cached) return cached;
  // Absent / unreadable / corrupted storage parses to the defaults; a
  // partially stale blob keeps every field that still validates.
  cached = parseSettings(readJson(KEY));
  return cached;
}

function save(next: Settings) {
  cached = next;
  // Best-effort: a refused write (storage full/disabled) keeps the in-memory settings for this session.
  writeJson(KEY, next);
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function getSnapshot(): Settings {
  return load();
}

/**
 * The persisted theme, for pre-React bootstrap (sets data-theme before the
 * first paint). Uses the same load path as useSettings, so the two can never
 * disagree about the key or the parsing.
 */
export function loadInitialTheme(): Settings["theme"] {
  return load().theme;
}

export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const settings = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const update = useCallback(
    (patch: Partial<Settings>) => save({ ...load(), ...patch }),
    [],
  );
  return [settings, update];
}

export function formatTimeSetting(ts: number, fmt: TimeFormat): string {
  const d = new Date(ts);
  if (fmt === "24h") {
    return d.toLocaleString("en-GB", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    });
  }
  return d.toLocaleString();
}

/** Time of day only (log rows), honouring the same TimeFormat setting. */
export function formatTimeOfDaySetting(ts: number, fmt: TimeFormat): string {
  const d = new Date(ts);
  if (fmt === "24h") {
    return d.toLocaleTimeString("en-GB", {
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    });
  }
  return d.toLocaleTimeString();
}
