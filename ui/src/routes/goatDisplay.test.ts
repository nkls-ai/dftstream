import { describe, expect, test } from "bun:test";
import { sortRows } from "../lib/tableSort";
import type { GoatConformer, GoatSummary } from "./goat";
import {
  GOAT_SORT_ACCESSORS,
  effectiveGoatColumns,
  goatColumnVisibility,
  goatConformersBelow3Kcal,
  goatHasHeadline,
  goatHasMeta,
  goatSelectedDetails,
  goatTotalPopulation,
  parseGoatColumnPrefs,
} from "./goatDisplay";
import { relEnergyFormat } from "../lib/energyUnits";
const kcal = relEnergyFormat("kcal");

const emptySummary: GoatSummary = { iterations: [], conformers: [] };

describe("goatColumnVisibility", () => {
  test("all hidden for empty ensemble", () => {
    expect(goatColumnVisibility([])).toEqual({
      hasAbsEnergy: false,
      hasRelativeEnergy: false,
      hasDegeneracy: false,
      hasPercentTotal: false,
      hasPercentCumulative: false,
    });
  });

  test("a column shows when any conformer has the field", () => {
    const conformers: GoatConformer[] = [
      { index: 0, absoluteEnergyEh: -100.1 },
      { index: 1, relativeEnergyKcalMol: 0.5, degeneracy: 2, percentTotal: 60, percentCumulative: 60 },
    ];
    expect(goatColumnVisibility(conformers)).toEqual({
      hasAbsEnergy: true,
      hasRelativeEnergy: true,
      hasDegeneracy: true,
      hasPercentTotal: true,
      hasPercentCumulative: true,
    });
  });
});

describe("goatTotalPopulation", () => {
  test("sums percentTotal treating missing as zero", () => {
    expect(goatTotalPopulation([{ index: 0, percentTotal: 60.5 }, { index: 1 }, { index: 2, percentTotal: 39.5 }])).toBe(100);
    expect(goatTotalPopulation([])).toBe(0);
  });
});

describe("goatConformersBelow3Kcal", () => {
  test("prefers ORCA-reported count", () => {
    expect(goatConformersBelow3Kcal({ ...emptySummary, conformersBelow3Kcal: 7 }, [{ index: 0 }])).toBe(7);
  });

  test("falls back to ensemble size, null when empty", () => {
    expect(goatConformersBelow3Kcal(emptySummary, [{ index: 0 }, { index: 1 }])).toBe(2);
    expect(goatConformersBelow3Kcal(null, [])).toBeNull();
  });
});

describe("goatHasHeadline / goatHasMeta", () => {
  test("headline requires at least one tile value", () => {
    expect(goatHasHeadline(null, null)).toBe(false);
    expect(goatHasHeadline(null, 3)).toBe(true);
    expect(goatHasHeadline({ ...emptySummary, lowestEnergyEh: -1 }, null)).toBe(true);
    expect(goatHasHeadline({ ...emptySummary, sconfCalMolK: 1.2 }, null)).toBe(true);
    expect(goatHasHeadline({ ...emptySummary, gconfKcalMol: -0.4 }, null)).toBe(true);
  });

  test("meta requires version, workers, temperature, or population", () => {
    expect(goatHasMeta(null, 0)).toBe(false);
    expect(goatHasMeta({ ...emptySummary, version: "2.0" }, 0)).toBe(true);
    expect(goatHasMeta({ ...emptySummary, finalWorkers: 8 }, 0)).toBe(true);
    expect(goatHasMeta({ ...emptySummary, ensembleTemperatureK: 298.15 }, 0)).toBe(true);
    expect(goatHasMeta(emptySummary, 99.9)).toBe(true);
  });
});

describe("parseGoatColumnPrefs", () => {
  test("non-object input yields empty prefs", () => {
    expect(parseGoatColumnPrefs(null)).toEqual({});
    expect(parseGoatColumnPrefs(undefined)).toEqual({});
    expect(parseGoatColumnPrefs("junk")).toEqual({});
    expect(parseGoatColumnPrefs(42)).toEqual({});
  });

  test("keeps only known keys with boolean values", () => {
    expect(
      parseGoatColumnPrefs({
        hasAbsEnergy: false,
        hasDegeneracy: true,
        hasPercentTotal: "yes",
        bogus: false,
      }),
    ).toEqual({ hasAbsEnergy: false, hasDegeneracy: true });
  });
});

describe("effectiveGoatColumns", () => {
  const allAvailable = {
    hasAbsEnergy: true,
    hasRelativeEnergy: true,
    hasDegeneracy: true,
    hasPercentTotal: true,
    hasPercentCumulative: true,
  };

  test("missing prefs default to visible", () => {
    expect(effectiveGoatColumns(allAvailable, {})).toEqual(allAvailable);
  });

  test("a user-hidden column is dropped", () => {
    expect(effectiveGoatColumns(allAvailable, { hasDegeneracy: false })).toEqual({
      ...allAvailable,
      hasDegeneracy: false,
    });
  });

  test("a pref cannot resurrect a column the data lacks", () => {
    expect(
      effectiveGoatColumns({ ...allAvailable, hasAbsEnergy: false }, { hasAbsEnergy: true }),
    ).toEqual({ ...allAvailable, hasAbsEnergy: false });
  });
});

describe("GOAT_SORT_ACCESSORS", () => {
  const conformers: GoatConformer[] = [
    { index: 0, absoluteEnergyEh: -100.3, relativeEnergyKcalMol: 0, degeneracy: 1, percentTotal: 50, percentCumulative: 50 },
    { index: 1, absoluteEnergyEh: -100.1, relativeEnergyKcalMol: 1.2, degeneracy: 3, percentTotal: 30, percentCumulative: 80 },
    { index: 2, absoluteEnergyEh: -100.2, relativeEnergyKcalMol: 0.6, degeneracy: 2, percentTotal: 20, percentCumulative: 100 },
  ];

  test("sorting by energy reorders rows without touching cumulative values", () => {
    const sorted = sortRows(conformers, { key: "energy", dir: "desc" }, GOAT_SORT_ACCESSORS);
    expect(sorted.map((c) => c.index)).toEqual([1, 2, 0]);
    // Cumulative % rides along with its conformer — still the natural-order totals.
    expect(sorted.map((c) => c.percentCumulative)).toEqual([80, 100, 50]);
    // Input untouched.
    expect(conformers.map((c) => c.index)).toEqual([0, 1, 2]);
  });

  test("degeneracy desc puts the most degenerate conformer first", () => {
    const sorted = sortRows(conformers, { key: "degen", dir: "desc" }, GOAT_SORT_ACCESSORS);
    expect(sorted.map((c) => c.degeneracy)).toEqual([3, 2, 1]);
  });

  test("missing values collate last", () => {
    const withGap: GoatConformer[] = [{ index: 5 }, ...conformers];
    const sorted = sortRows(withGap, { key: "pctTotal", dir: "desc" }, GOAT_SORT_ACCESSORS);
    expect(sorted[sorted.length - 1]?.index).toBe(5);
  });
});

describe("goatSelectedDetails", () => {
  test("formats present fields and drops missing ones", () => {
    expect(goatSelectedDetails({ index: 0, relativeEnergyKcalMol: 1.2341, percentTotal: 42.678 }, kcal))
      .toEqual(["1.234 kcal/mol", "42.68% ensemble"]);
    expect(goatSelectedDetails({ index: 0, percentTotal: 10 }, kcal)).toEqual(["10.00% ensemble"]);
    expect(goatSelectedDetails({ index: 0 }, kcal)).toEqual([]);
    expect(goatSelectedDetails(undefined, kcal)).toEqual([]);
  });

  test("follows the relative-energy unit", () => {
    expect(goatSelectedDetails({ index: 0, relativeEnergyKcalMol: 1 }, relEnergyFormat("kj"))).toEqual(["4.18 kJ/mol"]);
  });
});
