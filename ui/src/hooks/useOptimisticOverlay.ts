import { useCallback, useMemo, useState } from "react";

export interface OptimisticOverlay<T> {
  /** Rows minus pending removals, with pending renames applied. */
  visible: T[];
  markRemoving: (id: string) => void;
  unmarkRemoving: (id: string) => void;
  setRename: (id: string, name: string) => void;
  clearRename: (id: string) => void;
}

/**
 * Optimistic remove/rename overlay for a reactive list.
 *
 * Rows being deleted are hidden immediately; the reactive query catches up a
 * moment later. If the delete fails the caller un-marks the id and the row
 * reappears. Renames overlay the user-typed name until the query reflects the
 * change (callers clear the overlay after a grace period or on error).
 */
export function useOptimisticOverlay<T extends { id: string; name?: string }>(
  data: T[] | undefined,
): OptimisticOverlay<T> {
  const [pendingRemove, setPendingRemove] = useState<Set<string>>(new Set());
  const [pendingRename, setPendingRename] = useState<Record<string, string>>(
    {},
  );

  const visible = useMemo(() => {
    const rows = (data ?? []).filter((r) => !pendingRemove.has(r.id));
    return rows.map((r) =>
      // Overriding `name` with a plain string stays within T's shape.
      pendingRename[r.id] ? ({ ...r, name: pendingRename[r.id]! } as T) : r,
    );
  }, [data, pendingRemove, pendingRename]);

  const markRemoving = useCallback(
    (id: string) => setPendingRemove((s) => new Set(s).add(id)),
    [],
  );
  const unmarkRemoving = useCallback(
    (id: string) =>
      setPendingRemove((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      }),
    [],
  );
  const setRename = useCallback(
    (id: string, name: string) =>
      setPendingRename((m) => ({ ...m, [id]: name })),
    [],
  );
  const clearRename = useCallback(
    (id: string) =>
      setPendingRename((m) => {
        const n = { ...m };
        delete n[id];
        return n;
      }),
    [],
  );

  return { visible, markRemoving, unmarkRemoving, setRename, clearRename };
}
