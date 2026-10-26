// Pure helpers for the relaxed-surface-scan tab: grid construction for the
// 2D/3D surface plot and derived headline statistics. React-free so they can
// be unit tested directly.

import { HARTREE_TO_KCAL } from "../lib/constants";
import type { CriticalPoint, ScanPoint, ScanSummary } from "./scan";

export function uniqueSorted(values: number[]): number[] {
  return Array.from(new Set(values.map((v) => Number(v.toFixed(8))))).sort((a, b) => a - b);
}

export function sameCoord(a: number | undefined, b: number | undefined | null): boolean {
  return a != null && b != null && Math.abs(a - b) < 1e-7;
}

export function coordValueText(summary: ScanSummary, point: ScanPoint): string {
  return summary.coordinates
    .map((coord, i) => `${coord.label} ${point.coords[i]?.toFixed(4) ?? "?"}`)
    .join(" · ");
}

export function minScanEnergy(points: ScanPoint[]): number {
  let minE = Infinity;
  for (const p of points) if (p.energy < minE) minE = p.energy;
  return minE;
}

export interface ScanCritStats {
  barrier: number | null;
  saddle: CriticalPoint | undefined;
  minimaCount: number;
}

export function scanCritStats(dimensions: number, crits: CriticalPoint[]): ScanCritStats {
  const saddle = crits.find((c) => c.kind === "saddle");
  const maxima = crits.filter((c) => c.kind === "maximum");
  const barrier = dimensions >= 2
    ? (saddle?.deltaE ?? (maxima[0]?.deltaE ?? null))
    : (maxima[0]?.deltaE ?? null);
  return { barrier, saddle, minimaCount: crits.filter((c) => c.kind === "minimum").length };
}

export interface ScanSurfaceGrid {
  zGrid: (number | null)[][];
  idxGrid: (number | null)[][];
}

// Builds the (ys x xs) grid of relative energies (kcal/mol) plus, per cell,
// the index of the matching point in the full `points` array (null for holes).
export function buildScanSurfaceGrid(args: {
  visiblePoints: ScanPoint[];
  xs: number[];
  ys: number[];
  xDim: number;
  yDim: number;
  points: ScanPoint[];
  minE: number;
}): ScanSurfaceGrid {
  const { visiblePoints, xs, ys, xDim, yDim, points, minE } = args;
  const zG: (number | null)[][] = [];
  const iG: (number | null)[][] = [];
  for (let yi = 0; yi < ys.length; yi++) {
    const zRow: (number | null)[] = [];
    const iRow: (number | null)[] = [];
    for (let xi = 0; xi < xs.length; xi++) {
      const p = visiblePoints.find(
        (pt) => sameCoord(pt.coords[xDim], xs[xi]) && sameCoord(pt.coords[yDim], ys[yi]),
      );
      zRow.push(p ? (p.energy - minE) * HARTREE_TO_KCAL : null);
      iRow.push(p ? points.indexOf(p) : null);
    }
    zG.push(zRow);
    iG.push(iRow);
  }
  return { zGrid: zG, idxGrid: iG };
}
