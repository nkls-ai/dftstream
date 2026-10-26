// Pure data-shaping helpers for the run Overview tab. No React here so the
// verdict/labeling logic stays unit-testable.
import type { Run } from "../data/types";
import type { OverviewConvergence } from "../lib/convergence";
import { lookupScaleFactor } from "../lib/irSpectrum";

/** "CPCM(water)" when both model+solvent are known, "water" when only the
 *  solvent is, null when the run has no solvent. */
export function solventDisplayLabel(
  r: Pick<Run, "solvent" | "solventModel">,
): string | null {
  return r.solvent
    ? r.solventModel
      ? `${r.solventModel}(${r.solvent})`
      : r.solvent
    : null;
}

type MethodDetailFields = Pick<
  Run,
  | "functional"
  | "basis"
  | "method"
  | "scfTier"
  | "optTier"
  | "grid"
  | "runTypes"
  | "corrections"
  | "charge"
  | "mult"
  | "keywords"
>;

/** True when the run carries any parsed method/molecule metadata worth a
 *  meta strip (functional, basis, solvent, charge, ...). */
export function hasMethodDetails(
  r: MethodDetailFields,
  solventLabel: string | null,
): boolean {
  return Boolean(
    r.functional ||
      r.basis ||
      r.method ||
      solventLabel ||
      r.scfTier ||
      r.optTier ||
      r.grid ||
      r.runTypes?.length ||
      r.corrections?.length ||
      r.charge != null ||
      r.mult != null ||
      r.keywords?.length,
  );
}

/** "B3LYP/def2-SVP" style method label for the meta strip; prefers
 *  functional over method, appends the basis when present. */
export function methodDisplayValue(
  r: Pick<Run, "functional" | "method" | "basis">,
): string {
  return r.functional
    ? r.basis
      ? `${r.functional}/${r.basis}`
      : r.functional
    : r.method
      ? r.basis
        ? `${r.method}/${r.basis}`
        : r.method
      : r.basis ?? "";
}

/** IR frequency scale factor: user override by "functional/basis" key, then
 *  by bare functional, then the built-in literature table. */
export function resolveIrScale(
  irScaleFactors: Record<string, number>,
  functional: string | undefined,
  basis: string | undefined,
): number | undefined {
  return (
    irScaleFactors[`${functional}/${basis}`] ??
    irScaleFactors[functional ?? ""] ??
    lookupScaleFactor(functional, basis)
  );
}

/** Map a convergence verdict state to the summary-band tone class suffix. */
export function convergenceToneOf(
  state: OverviewConvergence["state"],
): "ok" | "bad" | "pending" {
  return state === "ok" ? "ok" : state === "bad" ? "bad" : "pending";
}

/** Tone for the imaginary-mode count tile: 0 is clean, exactly 1 is expected
 *  for a TS optimization, anything else is a warning. */
export function imaginaryModesTone(
  count: number,
  isOptTS: boolean,
): "ok" | "warn" {
  return count === 0 ? "ok" : isOptTS && count === 1 ? "ok" : "warn";
}

/** Tone for the spin-contamination tile. Rule of thumb: a deviation from
 *  S(S+1) beyond ~10% means the single-determinant description is
 *  questionable. For singlets (ideal 0, broken-symmetry UKS) an absolute
 *  cutoff replaces the relative one. */
export function spinContaminationTone(
  s2: number,
  s2Ideal: number,
): "ok" | "warn" {
  const dev = Math.abs(s2 - s2Ideal);
  if (s2Ideal < 0.1) return dev <= 0.1 ? "ok" : "warn";
  return dev / s2Ideal <= 0.1 ? "ok" : "warn";
}

/** Sub-line under the imaginary-mode count: wavenumber list or "clean". */
export function imaginaryModesSummary(
  imagFreqs: { wavenumber: number }[],
): string {
  return imagFreqs.length
    ? imagFreqs.map((f) => `${f.wavenumber.toFixed(0)} cm⁻¹`).join(" · ")
    : "clean spectrum";
}
