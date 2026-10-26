import type { Run } from "../data/types";

/**
 * The run with the lowest (most negative) final energy in a non-empty group.
 * Runs without an energy are treated as 0 Eh, matching the historical
 * benchmark-table behavior of preferring any bound energy over "unknown".
 */
export function lowestEnergyRun(runs: Run[]): Run {
  return runs.reduce((a, b) =>
    (a.lastEnergy ?? 0) < (b.lastEnergy ?? 0) ? a : b,
  );
}
