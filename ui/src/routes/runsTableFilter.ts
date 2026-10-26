import type { Run } from "../data/types";

// Fields the runs-table search box matches against, lowercased. Mirrors
// what the table actually displays plus the keyword chips.
function haystack(r: Run): string[] {
  return [
    r.name,
    r.functional,
    r.method,
    r.basis,
    r.solvent,
    r.submittedBy,
    r.jobType,
    ...(r.keywords ?? []),
    ...(r.runTypes ?? []),
    ...(r.tags ?? []),
  ]
    .filter((s): s is string => s != null)
    .map((s) => s.toLowerCase());
}

/**
 * Case-insensitive substring filter for the runs table. An empty or
 * whitespace-only query returns the input array untouched so the natural
 * (newest-first) order and identity are preserved.
 */
export function filterRuns(runs: readonly Run[], query: string): readonly Run[] {
  const q = query.trim().toLowerCase();
  if (!q) return runs;
  return runs.filter((r) => haystack(r).some((s) => s.includes(q)));
}
