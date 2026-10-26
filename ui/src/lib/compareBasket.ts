import { useSyncExternalStore } from "react";
import { STORAGE_KEYS } from "./storageKeys";
import { readJson, writeJson } from "./persistedJson";

// Cross-experiment compare basket: a persisted set of run ids the user
// collects from anywhere in the app and compares on /compare. Same
// external-store pattern as lib/settings so every subscriber (row
// toggles, floating pill, compare page) stays in sync.

const KEY = STORAGE_KEYS.compareBasket;
const MAX_RUNS = 50;

let cached: string[] | null = null;
const listeners = new Set<() => void>();

function load(): string[] {
  if (cached) return cached;
  const parsed = readJson(KEY);
  cached = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  return cached;
}

function save(next: string[]) {
  cached = next;
  // Best-effort: a refused write (storage full/disabled) keeps the in-memory basket for this session.
  writeJson(KEY, next);
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function compareBasketToggle(runId: string): void {
  const cur = load();
  if (cur.includes(runId)) {
    save(cur.filter((id) => id !== runId));
  } else if (cur.length < MAX_RUNS) {
    save([...cur, runId]);
  }
}

export function compareBasketRemove(runId: string): void {
  save(load().filter((id) => id !== runId));
}

export function compareBasketClear(): void {
  save([]);
}

export function useCompareBasket(): string[] {
  return useSyncExternalStore(subscribe, load, load);
}
