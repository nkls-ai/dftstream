// Shared column-sort logic for every table in the app. Pure and
// framework-free so it can be unit-tested; React wiring lives in
// hooks/useTableSort.ts and the header cell in components/SortableTh.tsx.

export type SortDir = "asc" | "desc";

export interface SortState {
  key: string;
  dir: SortDir;
}

/** Accessor map: column key -> value to sort that column by. */
export type SortAccessors<T> = Record<string, (row: T) => unknown>;

/**
 * Cycle a column's sort on header click: fresh column starts at its
 * default direction, a second click flips it, a third clears sorting so
 * the table returns to its natural order.
 */
export function toggleSort(
  current: SortState | null,
  key: string,
  defaultDir: SortDir = "asc",
): SortState | null {
  if (current?.key !== key) return { key, dir: defaultDir };
  if (current.dir === defaultDir) {
    return { key, dir: defaultDir === "asc" ? "desc" : "asc" };
  }
  return null;
}

/**
 * Compare two cell values: numbers numerically, strings
 * case-insensitively, booleans false<true. null/undefined/NaN always
 * collate last regardless of direction (the caller applies `dir` only to
 * the non-null comparison).
 */
export function compareValues(a: unknown, b: unknown): number {
  const aMissing = isMissing(a);
  const bMissing = isMissing(b);
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") {
    return Number(a) - Number(b);
  }
  return String(a).localeCompare(String(b), undefined, {
    sensitivity: "base",
    numeric: true,
  });
}

function isMissing(v: unknown): boolean {
  return v == null || (typeof v === "number" && Number.isNaN(v));
}

/**
 * Return rows sorted by the active column, or the input array untouched
 * when sorting is cleared or the key has no accessor. Never mutates the
 * input; ties keep their original relative order (Array#sort is stable).
 */
export function sortRows<T>(
  rows: readonly T[],
  state: SortState | null,
  accessors: SortAccessors<T>,
): readonly T[] {
  if (!state) return rows;
  const accessor = accessors[state.key];
  if (!accessor) return rows;
  const sign = state.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const cmp = compareValues(accessor(a), accessor(b));
    // Missing values stay last in both directions: compareValues already
    // put them there, so only flip the sign for real comparisons.
    if (isMissing(accessor(a)) || isMissing(accessor(b))) return cmp;
    return cmp * sign;
  });
}

/** aria-sort value for a header cell, for screen readers. */
export function ariaSort(
  state: SortState | null,
  key: string,
): "ascending" | "descending" | "none" {
  if (state?.key !== key) return "none";
  return state.dir === "asc" ? "ascending" : "descending";
}
