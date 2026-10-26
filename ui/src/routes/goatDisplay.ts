import type { SortAccessors } from "../lib/tableSort";
import type { GoatConformer, GoatSummary } from "./goat";
import type { RelEnergyFormat } from "../lib/energyUnits";

export interface GoatColumnVisibility {
  hasAbsEnergy: boolean;
  hasRelativeEnergy: boolean;
  hasDegeneracy: boolean;
  hasPercentTotal: boolean;
  hasPercentCumulative: boolean;
}

export const GOAT_COLUMN_KEYS = [
  "hasAbsEnergy",
  "hasRelativeEnergy",
  "hasDegeneracy",
  "hasPercentTotal",
  "hasPercentCumulative",
] as const satisfies readonly (keyof GoatColumnVisibility)[];

/**
 * User show/hide choices for the GOAT ensemble columns; a missing key
 * means "visible". Persisted per table under STORAGE_KEYS.tableColumns.
 */
export type GoatColumnPrefs = Partial<Record<keyof GoatColumnVisibility, boolean>>;

/** Validate an untrusted localStorage blob into column prefs. */
export function parseGoatColumnPrefs(raw: unknown): GoatColumnPrefs {
  if (raw == null || typeof raw !== "object") return {};
  const prefs: GoatColumnPrefs = {};
  for (const key of GOAT_COLUMN_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === "boolean") prefs[key] = value;
  }
  return prefs;
}

/**
 * A column renders only when the parser produced data for it AND the
 * user has not hidden it.
 */
export function effectiveGoatColumns(
  available: GoatColumnVisibility,
  prefs: GoatColumnPrefs,
): GoatColumnVisibility {
  return {
    hasAbsEnergy: available.hasAbsEnergy && (prefs.hasAbsEnergy ?? true),
    hasRelativeEnergy: available.hasRelativeEnergy && (prefs.hasRelativeEnergy ?? true),
    hasDegeneracy: available.hasDegeneracy && (prefs.hasDegeneracy ?? true),
    hasPercentTotal: available.hasPercentTotal && (prefs.hasPercentTotal ?? true),
    hasPercentCumulative: available.hasPercentCumulative && (prefs.hasPercentCumulative ?? true),
  };
}

/**
 * Sort accessors for the ensemble table. `pctCumul` sorts by the value
 * computed in natural (parser) order — the physically meaningful one —
 * so sorting only reorders rows, never recomputes the running total.
 */
export const GOAT_SORT_ACCESSORS: SortAccessors<GoatConformer> = {
  conf: (c) => c.index,
  energy: (c) => c.absoluteEnergyEh,
  rel: (c) => c.relativeEnergyKcalMol,
  degen: (c) => c.degeneracy,
  pctTotal: (c) => c.percentTotal,
  pctCumul: (c) => c.percentCumulative,
};

export function goatColumnVisibility(conformers: GoatConformer[]): GoatColumnVisibility {
  return {
    hasAbsEnergy: conformers.some((c) => c.absoluteEnergyEh != null),
    hasRelativeEnergy: conformers.some((c) => c.relativeEnergyKcalMol != null),
    hasDegeneracy: conformers.some((c) => c.degeneracy != null),
    hasPercentTotal: conformers.some((c) => c.percentTotal != null),
    hasPercentCumulative: conformers.some((c) => c.percentCumulative != null),
  };
}

export function goatTotalPopulation(conformers: GoatConformer[]): number {
  return conformers.reduce((sum, c) => sum + (c.percentTotal ?? 0), 0);
}

export function goatConformersBelow3Kcal(
  summary: GoatSummary | null,
  conformers: GoatConformer[],
): number | null {
  return summary?.conformersBelow3Kcal ?? (conformers.length > 0 ? conformers.length : null);
}

export function goatHasHeadline(
  summary: GoatSummary | null,
  conformersBelow3Kcal: number | null,
): boolean {
  return (
    conformersBelow3Kcal != null ||
    summary?.lowestEnergyEh != null ||
    summary?.sconfCalMolK != null ||
    summary?.gconfKcalMol != null
  );
}

export function goatHasMeta(summary: GoatSummary | null, population: number): boolean {
  return Boolean(
    summary?.version ||
      summary?.finalWorkers != null ||
      summary?.ensembleTemperatureK != null ||
      population > 0,
  );
}

/** "1.234 kcal/mol" in the user's relative-energy unit (one digit finer than
 *  the unit default: conformer spacings are often sub-kcal). */
export function goatRelEnergyText(kcal: number, rel: RelEnergyFormat): string {
  return `${rel.formatKcal(kcal, 1)} ${rel.label}`;
}

export function goatSelectedDetails(
  selected: GoatConformer | undefined,
  rel: RelEnergyFormat,
): string[] {
  return [
    selected?.relativeEnergyKcalMol != null
      ? goatRelEnergyText(selected.relativeEnergyKcalMol, rel)
      : null,
    selected?.percentTotal != null
      ? `${selected.percentTotal.toFixed(2)}% ensemble`
      : null,
  ].filter((x): x is string => x != null);
}
