import { HARTREE_TO_EV, HARTREE_TO_KCAL, HARTREE_TO_KJ } from "./constants";

// The user-selectable unit for RELATIVE energies (ΔE, ΔG). Absolute
// energies stay in Hartree everywhere — that is the working currency of
// ORCA outputs and what chemists paste onward.
export type EnergyUnit = "eh" | "kcal" | "kj" | "ev";

export const ENERGY_UNIT_OPTIONS: { value: EnergyUnit; label: string }[] = [
  { value: "eh", label: "Hartree (Eh)" },
  { value: "kcal", label: "kcal/mol" },
  { value: "kj", label: "kJ/mol" },
  { value: "ev", label: "eV" },
];

const UNIT_LABELS: Record<EnergyUnit, string> = {
  eh: "Eh",
  kcal: "kcal/mol",
  kj: "kJ/mol",
  ev: "eV",
};

const FROM_EH: Record<EnergyUnit, number> = {
  eh: 1,
  kcal: HARTREE_TO_KCAL,
  kj: HARTREE_TO_KJ,
  ev: HARTREE_TO_EV,
};

// Sensible display precision per unit: chemical-accuracy differences are
// ~1.6e-3 Eh ≈ 1 kcal/mol ≈ 4.2 kJ/mol ≈ 0.04 eV.
const DECIMALS: Record<EnergyUnit, number> = {
  eh: 6,
  kcal: 2,
  kj: 1,
  ev: 3,
};

export function energyUnitLabel(unit: EnergyUnit): string {
  return UNIT_LABELS[unit];
}

export function ehTo(unit: EnergyUnit, eh: number): number {
  return eh * FROM_EH[unit];
}

/** Placeholder for an energy cell (absolute or relative) with no value. */
export const EMPTY_ENERGY = "—";

function isNum(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v);
}

/**
 * Relative energy (a difference, given in Eh) in `unit` at the unit's
 * display precision; `extraDecimals` widens it where finer steps matter
 * (conformer spacings, MECP gaps). Missing values render EMPTY_ENERGY.
 */
export function formatRelEnergy(
  unit: EnergyUnit,
  eh: number | null | undefined,
  extraDecimals = 0,
): string {
  return isNum(eh) ? ehTo(unit, eh).toFixed(DECIMALS[unit] + extraDecimals) : EMPTY_ENERGY;
}

/** Relative energy already in kcal/mol (ORCA's own PATH SUMMARY, GOAT tables) → Eh. */
export function kcalToEh(kcal: number): number {
  return kcal / HARTREE_TO_KCAL;
}

/**
 * Absolute energy in Eh at the user's `energyDecimals` precision. Missing
 * or non-finite values render EMPTY_ENERGY.
 */
export function formatEh(eh: number | null | undefined, decimals: number): string {
  return isNum(eh) ? eh.toFixed(decimals) : EMPTY_ENERGY;
}

/** CSV column suffix, e.g. rel_e_kcal / rel_e_kj / rel_e_ev / rel_e_eh. */
export function energyUnitSlug(unit: EnergyUnit): string {
  return unit;
}

/** The user's relative-energy unit bundled for display: label, conversions, formatters. */
export interface RelEnergyFormat {
  unit: EnergyUnit;
  /** "kcal/mol", "Eh", … — for headers, axis labels and unit suffixes. */
  label: string;
  /** Numeric value in `unit` (chart data). */
  fromEh: (eh: number) => number;
  fromKcal: (kcal: number) => number;
  format: (eh: number | null | undefined, extraDecimals?: number) => string;
  formatKcal: (kcal: number | null | undefined, extraDecimals?: number) => string;
  /** A value already converted to `unit` (chart tooltips). */
  formatValue: (v: number) => string;
  /** Chart series kept in kcal/mol internally, re-expressed in `unit`. */
  seriesFromKcal: <P extends { y: number }>(points: readonly P[]) => P[];
}

export function relEnergyFormat(unit: EnergyUnit): RelEnergyFormat {
  return {
    unit,
    label: energyUnitLabel(unit),
    fromEh: (eh) => ehTo(unit, eh),
    fromKcal: (kcal) => ehTo(unit, kcalToEh(kcal)),
    format: (eh, extra = 0) => formatRelEnergy(unit, eh, extra),
    formatKcal: (kcal, extra = 0) =>
      formatRelEnergy(unit, kcal != null ? kcalToEh(kcal) : kcal, extra),
    formatValue: (v) => (Number.isFinite(v) ? v.toFixed(DECIMALS[unit]) : EMPTY_ENERGY),
    seriesFromKcal: (points) => points.map((p) => ({ ...p, y: ehTo(unit, kcalToEh(p.y)) })),
  };
}
