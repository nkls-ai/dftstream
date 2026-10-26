import { describe, expect, test } from "bun:test";
import { HARTREE_TO_KCAL } from "../lib/constants";
import {
  buildGapSeries,
  buildMecpPoints,
  buildRelativeEnergySeries,
  mecpFinalStats,
  type MECPPoint,
} from "./mecpData";

function m(cycle: number | undefined, value: number) {
  return { ts: 0, cycle, value };
}

describe("buildMecpPoints", () => {
  test("merges the three metric streams by cycle, sorted", () => {
    const points = buildMecpPoints(
      [m(2, -75.2), m(1, -75.1)],
      [m(1, -75.05)],
      [m(1, 0.05), m(2, 0.01)],
    );
    expect(points).toEqual([
      { cycle: 1, state1Energy: -75.1, state2Energy: -75.05, gapEh: 0.05 },
      { cycle: 2, state1Energy: -75.2, gapEh: 0.01 },
    ]);
  });

  test("missing cycles bucket under 0 and undefined streams are tolerated", () => {
    expect(buildMecpPoints([m(undefined, -75)], undefined, undefined)).toEqual([
      { cycle: 0, state1Energy: -75 },
    ]);
    expect(buildMecpPoints(undefined, undefined, undefined)).toEqual([]);
  });
});

describe("buildGapSeries", () => {
  test("keeps only points with a gap, converted to kcal/mol", () => {
    const points: MECPPoint[] = [
      { cycle: 1, gapEh: 0.01 },
      { cycle: 2 },
      { cycle: 3, gapEh: 0.002 },
    ];
    expect(buildGapSeries(points)).toEqual([
      { x: 1, y: 0.01 * HARTREE_TO_KCAL },
      { x: 3, y: 0.002 * HARTREE_TO_KCAL },
    ]);
  });
});

describe("buildRelativeEnergySeries", () => {
  test("energies become kcal/mol relative to the overall minimum", () => {
    const rows = buildRelativeEnergySeries([
      { cycle: 1, state1Energy: -75.1, state2Energy: -75.0 },
      { cycle: 2, state1Energy: -75.05 },
    ]);
    expect(rows[0]?.state1).toBeCloseTo(0, 9);
    expect(rows[0]?.state2).toBeCloseTo(0.1 * HARTREE_TO_KCAL, 6);
    expect(rows[1]?.state1).toBeCloseTo(0.05 * HARTREE_TO_KCAL, 6);
    expect(rows[1]?.state2).toBeNull();
  });

  test("gap-only runs yield null energies instead of NaN", () => {
    const rows = buildRelativeEnergySeries([{ cycle: 1, gapEh: 0.01 }]);
    expect(rows).toEqual([{ cycle: 1, state1: null, state2: null }]);
  });
});

describe("mecpFinalStats", () => {
  test("averages both surfaces and converts the gap", () => {
    const stats = mecpFinalStats([
      { cycle: 1, gapEh: 0.05 },
      { cycle: 2, state1Energy: -75.2, state2Energy: -75.1, gapEh: 0.001 },
    ]);
    expect(stats.finalGapKcal).toBeCloseTo(0.001 * HARTREE_TO_KCAL, 9);
    expect(stats.finalEnergy).toBeCloseTo(-75.15, 9);
  });

  test("falls back to whichever single state energy exists", () => {
    expect(mecpFinalStats([{ cycle: 1, state2Energy: -75.3 }]).finalEnergy).toBe(-75.3);
    expect(mecpFinalStats([{ cycle: 1 }])).toEqual({ finalGapKcal: null, finalEnergy: null });
  });

  test("empty input yields nulls", () => {
    expect(mecpFinalStats([])).toEqual({ finalGapKcal: null, finalEnergy: null });
  });
});
