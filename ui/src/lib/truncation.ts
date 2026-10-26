/**
 * Labels for lists the backend truncated.
 *
 * `runs.listByExperiment` returns the newest 1000 runs of an experiment and
 * says nothing about the ones it dropped, so an experiment with 4200 runs used
 * to read "1000 runs" — a wrong number presented as an exact one. Every count,
 * denominator and "N of M" that is computed from a capped array has to go
 * through here so the partiality is stated once, the same way, everywhere.
 *
 * The convention matches the experiment cards' existing `runCountCapped`
 * rendering: a trailing "+" means "at least this many".
 */

export const TRUNCATION_TITLE =
  "This experiment has more runs than the server returns in one query. " +
  "Only the most recent ones are loaded, so counts, filters and relative " +
  "energies on this page cover that slice — not the whole experiment.";

/** "1000+ runs" when capped, "37 runs" when the list is complete. */
export function runCountLabel(count: number, capped: boolean): string {
  return `${countLabel(count, capped)} run${count === 1 && !capped ? "" : "s"}`;
}

/** Bare count with the "+" suffix — for embedding in a longer sentence. */
export function countLabel(count: number, capped: boolean): string {
  return capped ? `${count}+` : String(count);
}

/**
 * "12 of 1000+ loaded runs" vs "12 of 37 runs". The denominator of a filtered
 * view over a capped list is the loaded slice, never the true total, so the
 * wording changes rather than just gaining a "+".
 */
export function filteredCountLabel(
  shown: number,
  total: number,
  capped: boolean,
): string {
  return capped
    ? `${shown} of ${total} loaded runs — older runs are not loaded`
    : `${shown} of ${total} runs`;
}

/**
 * Warning for a value referenced against the minimum of a capped list. A
 * relative energy is only meaningful against the true global minimum; if the
 * lowest-energy run was truncated away, every ΔE in the table is offset by a
 * constant and silently wrong.
 */
export function relativeEnergyCaveat(capped: boolean): string | null {
  return capped
    ? "Relative energies are referenced to the lowest energy among the loaded runs. " +
        "Older runs are not loaded, so if the true minimum is among them every ΔE here is offset."
    : null;
}
