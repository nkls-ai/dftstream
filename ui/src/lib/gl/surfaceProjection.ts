/**
 * Pure projection + scene-building math for the Surface3D plot.
 * No canvas/DOM dependencies — everything here is unit-testable.
 */

export interface ZExtent {
  zMin: number;
  zMax: number;
  zRange: number;
}

/** Min/max/range over a z grid, ignoring null holes. All-null grids
 *  collapse to zMin = zMax = 0 (zRange floors at 1e-8 to avoid div-by-0). */
export function computeZExtent(zGrid: (number | null)[][]): ZExtent {
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const row of zGrid) {
    for (const v of row) {
      if (v == null) continue;
      if (v < zMin) zMin = v;
      if (v > zMax) zMax = v;
    }
  }
  if (!isFinite(zMin)) {
    zMin = 0;
    zMax = 0;
  }
  return { zMin, zMax, zRange: Math.max(1e-8, zMax - zMin) };
}

/** teal → amber → red gradient over the normalized z range. */
export function surfaceColorForZ(z: number, zMin: number, zRange: number): string {
  const t = Math.max(0, Math.min(1, (z - zMin) / zRange));
  if (t < 0.5) {
    const k = t / 0.5;
    return `rgb(${Math.round(94 + (251 - 94) * k)}, ${Math.round(234 + (191 - 234) * k)}, ${Math.round(212 + (36 - 212) * k)})`;
  }
  const k = (t - 0.5) / 0.5;
  return `rgb(${Math.round(251 + (248 - 251) * k)}, ${Math.round(191 + (113 - 191) * k)}, ${Math.round(36 + (113 - 36) * k)})`;
}

export interface ProjectorParams {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  zMin: number;
  zRange: number;
  /** Rotation about the horizontal axis, degrees. */
  rxDeg: number;
  /** Rotation about the vertical axis, degrees. */
  ryDeg: number;
  /** Canvas CSS width/height in px. */
  width: number;
  height: number;
}

/** Projects a data-space point to [screenX, screenY, viewZ] (viewZ used for
 *  painter's-algorithm depth sorting). */
export type Project = (px: number, py: number, pz: number) => [number, number, number];

/**
 * Builds the fixed-camera projector used by the surface plot: normalize each
 * axis to [−1, 1], rotate about Y then X, then apply a simple perspective
 * divide and center on the canvas.
 */
export function createProjector(p: ProjectorParams): Project {
  const radX = (p.rxDeg * Math.PI) / 180;
  const radY = (p.ryDeg * Math.PI) / 180;
  const cosX = Math.cos(radX);
  const sinX = Math.sin(radX);
  const cosY = Math.cos(radY);
  const sinY = Math.sin(radY);
  const xRange = Math.max(1e-8, p.xMax - p.xMin);
  const yRange = Math.max(1e-8, p.yMax - p.yMin);
  const { xMin, yMin, zMin, zRange, width: w, height: h } = p;

  return (px: number, py: number, pz: number): [number, number, number] => {
    const nx = ((px - xMin) / xRange - 0.5) * 2;
    const ny = ((py - yMin) / yRange - 0.5) * 2;
    const nz = -((pz - zMin) / zRange - 0.5) * 2;

    const x3 = nx * cosY - ny * sinY;
    const y3 = nx * sinY * cosX + ny * cosY * cosX - nz * sinX;
    const z3 = nx * sinY * sinX + ny * cosY * sinX + nz * cosX;

    const scale = w * 0.28;
    const perspective = 4;
    const factor = perspective / (perspective + z3);
    return [w / 2 + x3 * scale * factor, h / 2 + y3 * scale * factor, z3];
  };
}

export interface SurfaceQuad {
  pts: [number, number][];
  /** Average view-space depth — quads are sorted back-to-front on this. */
  z: number;
  fill: string;
  idx: number | null;
}

export interface ProjectedPoint {
  sx: number;
  sy: number;
  idx: number;
}

/**
 * Projects every grid point and assembles the fill quads (cells whose four
 * corners are all present). Quads come back sorted back-to-front, ready to
 * paint with the painter's algorithm.
 */
export function buildSurfaceScene(
  xs: number[],
  ys: number[],
  zGrid: (number | null)[][],
  pointIndices: (number | null)[][],
  project: Project,
  colorForZ: (z: number) => string,
): { quads: SurfaceQuad[]; projected: ProjectedPoint[] } {
  const quads: SurfaceQuad[] = [];
  const projected: ProjectedPoint[] = [];

  for (let yi = 0; yi < ys.length; yi++) {
    for (let xi = 0; xi < xs.length; xi++) {
      const z = zGrid[yi]?.[xi];
      if (z == null) continue;
      const [sx, sy] = project(xs[xi]!, ys[yi]!, z);
      const pIdx = pointIndices[yi]?.[xi];
      if (pIdx != null) projected.push({ sx, sy, idx: pIdx });

      if (xi < xs.length - 1 && yi < ys.length - 1) {
        const z01 = zGrid[yi]?.[xi + 1];
        const z10 = zGrid[yi + 1]?.[xi];
        const z11 = zGrid[yi + 1]?.[xi + 1];
        if (z01 != null && z10 != null && z11 != null) {
          const p00 = project(xs[xi]!, ys[yi]!, z);
          const p01 = project(xs[xi + 1]!, ys[yi]!, z01);
          const p11 = project(xs[xi + 1]!, ys[yi + 1]!, z11);
          const p10 = project(xs[xi]!, ys[yi + 1]!, z10);
          const avgZ = (p00[2] + p01[2] + p10[2] + p11[2]) / 4;
          const avgVal = (z + z01 + z10 + z11) / 4;
          quads.push({
            pts: [[p00[0], p00[1]], [p01[0], p01[1]], [p11[0], p11[1]], [p10[0], p10[1]]],
            z: avgZ,
            fill: colorForZ(avgVal),
            idx: null,
          });
        }
      }
    }
  }

  quads.sort((a, b) => b.z - a.z);
  return { quads, projected };
}

/** Nearest projected point within maxDist px of (mx, my), or null. */
export function findClosestProjected(
  points: ProjectedPoint[],
  mx: number,
  my: number,
  maxDist: number,
): number | null {
  let closest: { idx: number; dist: number } | null = null;
  for (const p of points) {
    const d = Math.hypot(p.sx - mx, p.sy - my);
    if (d < maxDist && (!closest || d < closest.dist)) closest = { idx: p.idx, dist: d };
  }
  return closest?.idx ?? null;
}

/** "Nice" tick positions (1/2/2.5/5 × 10^n steps) covering [min, max]. */
export function pickTicks(min: number, max: number, count: number): number[] {
  const range = max - min;
  if (range <= 0) return [min];
  const rough = range / Math.max(1, count - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const nice = [1, 2, 2.5, 5, 10].find((s) => s * mag >= rough) ?? 10;
  const step = nice * mag;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 0.01; v += step) {
    ticks.push(Math.round(v / step) * step);
  }
  return ticks;
}
