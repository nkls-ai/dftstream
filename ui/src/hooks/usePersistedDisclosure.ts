import { useCallback, useState } from "react";
import { STORAGE_KEYS } from "../lib/storageKeys";
import { readMapEntry, writeMapEntry } from "../lib/persistedMap";

export function loadDisclosure(sectionKey: string): boolean | null {
  const entry = readMapEntry(STORAGE_KEYS.sectionOpen, sectionKey);
  return typeof entry === "boolean" ? entry : null;
}

export function storeDisclosure(sectionKey: string, open: boolean): void {
  // Best-effort: a refused write (storage full/disabled) leaves the in-memory state in charge.
  writeMapEntry(STORAGE_KEYS.sectionOpen, sectionKey, open);
}

/**
 * Open/closed state for a collapsible section, persisted per sectionKey so
 * the user's choice survives reloads. Undefined key = plain ephemeral state.
 */
export function usePersistedDisclosure(
  sectionKey: string | undefined,
  defaultOpen: boolean,
): [boolean, (next: boolean) => void] {
  const [open, setOpen] = useState<boolean>(
    () => (sectionKey ? loadDisclosure(sectionKey) : null) ?? defaultOpen,
  );

  const set = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (sectionKey) storeDisclosure(sectionKey, next);
    },
    [sectionKey],
  );

  return [open, set];
}
