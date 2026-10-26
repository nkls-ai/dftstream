import { useCallback, useState } from "react";
import { STORAGE_KEYS } from "../lib/storageKeys";
import { readMapEntry, writeMapEntry } from "../lib/persistedMap";
import {
  toggleSort,
  sortRows,
  ariaSort,
  type SortAccessors,
  type SortDir,
  type SortState,
} from "../lib/tableSort";

export interface TableSort {
  sort: SortState | null;
  /** Header-click handler: cycles default dir -> flipped -> natural order. */
  toggle: (key: string, defaultDir?: SortDir) => void;
  /** Rows ordered by the active column (input order when sort is cleared). */
  sorted: <T>(rows: readonly T[], accessors: SortAccessors<T>) => readonly T[];
  ariaSortFor: (key: string) => "ascending" | "descending" | "none";
}

function isSortState(v: unknown): v is SortState {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Partial<SortState>;
  return typeof e.key === "string" && (e.dir === "asc" || e.dir === "desc");
}

function loadStored(tableId: string): SortState | null {
  const entry = readMapEntry(STORAGE_KEYS.tableSort, tableId);
  return isSortState(entry) ? entry : null;
}

function store(tableId: string, state: SortState | null): void {
  // Best-effort: a refused write (storage full/disabled) leaves the in-memory sort in charge.
  writeMapEntry(STORAGE_KEYS.tableSort, tableId, state ?? undefined);
}

/**
 * Column-sort state for one table, persisted per tableId so the user's
 * choice survives reloads. `defaultState` is the table's natural order
 * label (usually null = server/domain order).
 */
export function useTableSort(
  tableId: string,
  defaultState: SortState | null = null,
): TableSort {
  const [sort, setSort] = useState<SortState | null>(
    () => loadStored(tableId) ?? defaultState,
  );

  const toggle = useCallback(
    (key: string, defaultDir: SortDir = "asc") => {
      setSort((current) => {
        const next = toggleSort(current, key, defaultDir);
        store(tableId, next);
        return next;
      });
    },
    [tableId],
  );

  const sorted = useCallback(
    <T,>(rows: readonly T[], accessors: SortAccessors<T>) =>
      sortRows(rows, sort, accessors),
    [sort],
  );

  const ariaSortFor = useCallback(
    (key: string) => ariaSort(sort, key),
    [sort],
  );

  return { sort, toggle, sorted, ariaSortFor };
}
