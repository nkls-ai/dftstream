/**
 * The memory rule, shared with `inputbuild.MaxCoreMB` in the wrapper and
 * with the group's own tooling (`maxcore_from_memory`): a job may claim
 * 75% of physical RAM, split per core and rounded to whole GB. ORCA
 * treats %maxcore as a soft target and overshoots it, so the last
 * quarter is the margin that keeps the OOM killer away — `inputlint`
 * warns above exactly this line.
 */
export const SAFE_MEMORY_FRACTION = 0.75;

/**
 * Recommended per-core %maxcore (MB). Returns 0 when the inputs are
 * non-positive or the share rounds below 1 GB per core — the caller then
 * leaves %maxcore out rather than emitting a value ORCA would choke on.
 */
export function recommendedMaxCoreMB(totalRAMMB: number, nprocs: number): number {
  if (totalRAMMB <= 0 || nprocs <= 0) return 0;
  const perCoreGB = Math.round(((totalRAMMB / 1024) * SAFE_MEMORY_FRACTION) / nprocs);
  if (perCoreGB < 1) return 0;
  return perCoreGB * 1000;
}
