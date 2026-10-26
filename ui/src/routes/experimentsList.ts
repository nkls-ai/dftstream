import type { ExperimentSummary } from "../data/types";

export type ExperimentSortMode = "newest" | "name" | "runs" | "activity";

export const EXPERIMENT_SORT_OPTIONS: { value: ExperimentSortMode; label: string }[] = [
  { value: "newest", label: "Newest" },
  { value: "name", label: "Name A–Z" },
  { value: "runs", label: "Most runs" },
  { value: "activity", label: "Recently active" },
];

/**
 * Case-insensitive name filter for the experiments grid. An empty or
 * whitespace-only query returns the input array untouched.
 */
export function filterExperiments(
  xs: readonly ExperimentSummary[],
  query: string,
): readonly ExperimentSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return xs;
  return xs.filter((e) => e.name.toLowerCase().includes(q));
}

/**
 * Order the experiments grid. "newest" keeps the server's order (newest
 * first) and returns the input untouched; the others sort a copy, ties
 * keeping their server order (Array#sort is stable).
 */
export function sortExperiments(
  xs: readonly ExperimentSummary[],
  mode: ExperimentSortMode,
): readonly ExperimentSummary[] {
  if (mode === "newest") return xs;
  const copy = [...xs];
  switch (mode) {
    case "name":
      copy.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }),
      );
      break;
    case "runs":
      copy.sort((a, b) => b.runCount - a.runCount);
      break;
    case "activity":
      copy.sort((a, b) => b.lastActivity - a.lastActivity);
      break;
  }
  return copy;
}
