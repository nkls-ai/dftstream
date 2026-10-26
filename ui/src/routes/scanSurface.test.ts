import { describe, expect, test } from "bun:test";
import { HARTREE_TO_KCAL } from "../lib/constants";
import type { CriticalPoint, ScanPoint, ScanSummary } from "./scan";
import {
  buildScanSurfaceGrid,
  coordValueText,
  minScanEnergy,
  sameCoord,
  scanCritStats,
  uniqueSorted,
} from "./scanSurface";

function pt(step: number, coords: number[], energy: number): ScanPoint {
  return { step, coords, coordValue: coords[0] ?? step, energy };
}

function crit(idx: number, kind: CriticalPoint["kind"], deltaE: number): CriticalPoint {
  return { idx, kind, energy: 0, deltaE };
}

describe("uniqueSorted", () => {
  test("dedupes to 8 decimals and sorts ascending", () => {
    expect(uniqueSorted([1.2, 0.5, 1.200000001, 0.5])).toEqual([0.5, 1.2]);
  });

  test("keeps values that differ beyond the 8-decimal rounding", () => {
    expect(uniqueSorted([1.0, 1.0001])).toEqual([1.0, 1.0001]);
  });
});

describe("sameCoord", () => {
  test("matches within 1e-7 tolerance", () => {
    expect(sameCoord(1.0, 1.0 + 5e-8)).toBe(true);
    expect(sameCoord(1.0, 1.001)).toBe(false);
  });

  test("null/undefined never match", () => {
    expect(sameCoord(undefined, 1)).toBe(false);
    expect(sameCoord(1, null)).toBe(false);
    expect(sameCoord(undefined, undefined)).toBe(false);
  });
});

describe("coordValueText", () => {
  test("joins per-coordinate labels with values", () => {
    const summary = {
      coordinates: [
        { index: 0, kind: "Bond", atoms: "1-0", label: "Bond (1-0)" },
        { index: 1, kind: "Angle", atoms: "1-0-2", label: "Angle (1-0-2)" },
      ],
    } as ScanSummary;
    expect(coordValueText(summary, pt(1, [0.9, 104.5], -75))).toBe(
      "Bond (1-0) 0.9000 · Angle (1-0-2) 104.5000",
    );
  });

  test("missing coordinate values render as ?", () => {
    const summary = {
      coordinates: [
        { index: 0, kind: "Bond", atoms: "1-0", label: "Bond (1-0)" },
        { index: 1, kind: "Angle", atoms: "1-0-2", label: "Angle (1-0-2)" },
      ],
    } as ScanSummary;
    expect(coordValueText(summary, pt(1, [0.9], -75))).toBe(
      "Bond (1-0) 0.9000 · Angle (1-0-2) ?",
    );
  });
});

describe("minScanEnergy", () => {
  test("returns the lowest energy", () => {
    expect(minScanEnergy([pt(1, [0], -75.1), pt(2, [1], -75.3), pt(3, [2], -75.2)])).toBe(-75.3);
  });

  test("returns Infinity for an empty list", () => {
    expect(minScanEnergy([])).toBe(Infinity);
  });
});

describe("scanCritStats", () => {
  test("1D barrier comes from the first maximum", () => {
    const stats = scanCritStats(1, [
      crit(0, "minimum", 0),
      crit(2, "maximum", 12.5),
      crit(4, "minimum", 1.1),
    ]);
    expect(stats.barrier).toBe(12.5);
    expect(stats.saddle).toBeUndefined();
    expect(stats.minimaCount).toBe(2);
  });

  test("2D barrier prefers the saddle over maxima", () => {
    const stats = scanCritStats(2, [
      crit(0, "minimum", 0),
      crit(3, "saddle", 8.2),
      crit(5, "maximum", 20),
    ]);
    expect(stats.barrier).toBe(8.2);
    expect(stats.saddle?.idx).toBe(3);
  });

  test("2D falls back to the first maximum without a saddle", () => {
    expect(scanCritStats(2, [crit(1, "maximum", 15)]).barrier).toBe(15);
  });

  test("no critical points yields a null barrier", () => {
    expect(scanCritStats(1, []).barrier).toBeNull();
    expect(scanCritStats(2, []).barrier).toBeNull();
  });
});

describe("buildScanSurfaceGrid", () => {
  const points = [
    pt(1, [0, 0], -75.0),
    pt(2, [1, 0], -75.01),
    pt(3, [0, 1], -75.02),
    // hole at [1, 1]
  ];

  test("builds ys-by-xs grids with kcal/mol relative energies and point indices", () => {
    const { zGrid, idxGrid } = buildScanSurfaceGrid({
      visiblePoints: points,
      xs: [0, 1],
      ys: [0, 1],
      xDim: 0,
      yDim: 1,
      points,
      minE: -75.02,
    });
    expect(zGrid.length).toBe(2);
    expect(zGrid[0]?.[0]).toBeCloseTo(0.02 * HARTREE_TO_KCAL, 6);
    expect(zGrid[0]?.[1]).toBeCloseTo(0.01 * HARTREE_TO_KCAL, 6);
    expect(zGrid[1]?.[0]).toBeCloseTo(0, 6);
    expect(zGrid[1]?.[1]).toBeNull();
    expect(idxGrid).toEqual([
      [0, 1],
      [2, null],
    ]);
  });

  test("indices refer to the full points array, not the visible slice", () => {
    const visible = [points[2]!];
    const { idxGrid } = buildScanSurfaceGrid({
      visiblePoints: visible,
      xs: [0],
      ys: [1],
      xDim: 0,
      yDim: 1,
      points,
      minE: -75.02,
    });
    expect(idxGrid).toEqual([[2]]);
  });
});
