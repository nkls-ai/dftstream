// Pure view logic for the artifact file list: text filtering and the
// user-selectable sort modes. React-free so it can be unit tested.

import { kindRank } from "./artifactKind";

/** Sort modes offered by the artifact list's <select>. */
export type ArtifactSortMode = "kind" | "name" | "size";

/** The fields the list view needs — structural so tests stay lightweight. */
export interface ArtifactListItem {
  name: string;
  kind: string;
  sizeBytes: number;
}

/**
 * Case-insensitive substring match on the artifact name (the full stored
 * name, so matching the displayed basename always works too). A blank query
 * returns the input array unchanged.
 */
export function filterArtifacts<T extends ArtifactListItem>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return items;
  return items.filter((a) => a.name.toLowerCase().includes(q));
}

/**
 * Sorted copy per mode — never mutates the input:
 * - "kind": display kind order (kindRank), name as tiebreak (the default).
 * - "name": name A–Z.
 * - "size": largest first, name as tiebreak.
 */
export function sortArtifacts<T extends ArtifactListItem>(items: T[], mode: ArtifactSortMode): T[] {
  const out = items.slice();
  switch (mode) {
    case "name":
      out.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case "size":
      out.sort((a, b) => b.sizeBytes - a.sizeBytes || a.name.localeCompare(b.name));
      break;
    case "kind":
      out.sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.name.localeCompare(b.name));
      break;
  }
  return out;
}
