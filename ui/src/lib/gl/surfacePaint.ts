/**
 * Canvas-2D painters for the Surface3D plot. These take a ctx plus plain
 * data and draw — no React, no component state.
 */
import {
  pickTicks,
  type Project,
  type ProjectedPoint,
  type SurfaceQuad,
} from "./surfaceProjection";

export interface SurfaceMarker {
  idx: number;
  kind: "minimum" | "maximum" | "saddle";
  label: string;
}

/**
 * Syncs the canvas backing store to its CSS size × dpr and installs the dpr
 * transform. Only reassigns width/height when the size actually changed —
 * writing canvas.width/height forces a full GPU buffer realloc + clear, and
 * the caller redraws on every hover/drag frame. Uses setTransform (absolute)
 * instead of scale (relative) so the dpr transform doesn't compound across
 * draws. Returns the CSS-pixel size to draw in.
 */
export function syncCanvasBackingStore(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  dpr: number,
): { w: number; h: number } {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}

/** Paints depth-sorted quads with a subtle wireframe stroke. */
export function paintQuads(
  ctx: CanvasRenderingContext2D,
  quads: SurfaceQuad[],
  dark: boolean,
): void {
  for (const quad of quads) {
    ctx.beginPath();
    ctx.moveTo(quad.pts[0]![0], quad.pts[0]![1]);
    for (let i = 1; i < quad.pts.length; i++) ctx.lineTo(quad.pts[i]![0], quad.pts[i]![1]);
    ctx.closePath();
    ctx.fillStyle = quad.fill;
    ctx.fill();
    ctx.strokeStyle = dark ? "rgba(0,0,0,0.35)" : "rgba(0,0,0,0.12)";
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }
}

export interface AxesParams {
  project: Project;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  zMin: number;
  zMax: number;
  dark: boolean;
  xLabel?: string;
  yLabel?: string;
  zLabel?: string;
}

/** Paints the three axis lines, tick values, and optional axis labels. */
export function paintAxes(ctx: CanvasRenderingContext2D, p: AxesParams): void {
  const { project, xMin, xMax, yMin, yMax, zMin, zMax, dark, xLabel, yLabel, zLabel } = p;

  const axisColor = dark ? "rgba(255,255,255,0.25)" : "rgba(0,0,0,0.18)";
  const tickColor = dark ? "#6c727e" : "#8096AD";
  ctx.strokeStyle = axisColor;
  ctx.lineWidth = 1;

  const drawAxisLine = (from: [number, number, number], to: [number, number, number]) => {
    const [x1, y1] = project(from[0], from[1], from[2]);
    const [x2, y2] = project(to[0], to[1], to[2]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  };

  drawAxisLine([xMin, yMin, zMin], [xMax, yMin, zMin]);
  drawAxisLine([xMin, yMin, zMin], [xMin, yMax, zMin]);
  drawAxisLine([xMin, yMin, zMin], [xMin, yMin, zMax]);

  ctx.font = "10px 'JetBrains Mono', monospace";
  ctx.fillStyle = tickColor;

  const xTicks = pickTicks(xMin, xMax, 5);
  for (const v of xTicks) {
    const [tx, ty] = project(v, yMin, zMin);
    ctx.textAlign = "center";
    ctx.fillText(v.toFixed(2), tx, ty + 14);
  }
  const yTicks = pickTicks(yMin, yMax, 5);
  for (const v of yTicks) {
    const [tx, ty] = project(xMin, v, zMin);
    ctx.textAlign = "right";
    ctx.fillText(v.toFixed(2), tx - 6, ty + 4);
  }
  const zTicks = pickTicks(zMin, zMax, 4);
  for (const v of zTicks) {
    const [tx, ty] = project(xMin, yMin, v);
    ctx.textAlign = "right";
    ctx.fillText(v.toFixed(1), tx - 6, ty + 4);
  }

  ctx.font = "11px Inter, system-ui, sans-serif";
  ctx.fillStyle = dark ? "#9399a4" : "#526580";
  if (xLabel) {
    const [lx, ly] = project((xMin + xMax) / 2, yMin, zMin);
    ctx.textAlign = "center";
    ctx.fillText(xLabel, lx, ly + 28);
  }
  if (yLabel) {
    const [lx, ly] = project(xMin, (yMin + yMax) / 2, zMin);
    ctx.textAlign = "right";
    ctx.fillText(yLabel, lx - 18, ly + 4);
  }
  if (zLabel) {
    const [lx, ly] = project(xMin, yMin, (zMin + zMax) / 2);
    ctx.textAlign = "right";
    ctx.fillText(zLabel, lx - 18, ly + 4);
  }
}

/** Paints critical-point markers (minimum ◇ teal, maximum △ red, saddle ◇ amber). */
export function paintMarkers(
  ctx: CanvasRenderingContext2D,
  markers: SurfaceMarker[],
  projected: ProjectedPoint[],
  dark: boolean,
): void {
  for (const mk of markers) {
    const pp = projected.find((p) => p.idx === mk.idx);
    if (!pp) continue;
    const r = 7;
    ctx.lineWidth = 2;
    if (mk.kind === "minimum") {
      ctx.fillStyle = "rgb(94, 234, 212)";
      ctx.strokeStyle = dark ? "rgba(0,0,0,0.6)" : "rgba(255,255,255,0.9)";
      drawDiamond(ctx, pp.sx, pp.sy, r);
    } else if (mk.kind === "maximum") {
      ctx.fillStyle = "rgb(248, 113, 113)";
      ctx.strokeStyle = dark ? "rgba(0,0,0,0.6)" : "rgba(255,255,255,0.9)";
      drawTriangle(ctx, pp.sx, pp.sy, r);
    } else {
      ctx.fillStyle = "rgb(251, 191, 36)";
      ctx.strokeStyle = dark ? "rgba(0,0,0,0.6)" : "rgba(255,255,255,0.9)";
      drawDiamond(ctx, pp.sx, pp.sy, r);
    }
    ctx.fill();
    ctx.stroke();
    ctx.font = "bold 10px Inter, system-ui, sans-serif";
    ctx.fillStyle = dark ? "#d4d7de" : "#1a2332";
    ctx.textAlign = "center";
    ctx.fillText(mk.label, pp.sx, pp.sy - r - 4);
  }
}

/** Paints selected/hovered point rings, skipping points already drawn as markers. */
export function paintHighlights(
  ctx: CanvasRenderingContext2D,
  projected: ProjectedPoint[],
  selectedIdx: number | null | undefined,
  hovered: number | null,
  markerIdxs: Set<number>,
  dark: boolean,
): void {
  for (const p of projected) {
    const isSelected = p.idx === selectedIdx;
    const isHovered = p.idx === hovered;
    if (!isSelected && !isHovered) continue;
    if (markerIdxs.has(p.idx)) continue;
    ctx.beginPath();
    ctx.arc(p.sx, p.sy, isSelected ? 6 : 5, 0, Math.PI * 2);
    ctx.fillStyle = isSelected ? (dark ? "#fff" : "#000") : "rgba(255,255,255,0.7)";
    ctx.fill();
    ctx.strokeStyle = dark ? "#000" : "#fff";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function drawDiamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
}

function drawTriangle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y + r * 0.7);
  ctx.lineTo(x - r, y + r * 0.7);
  ctx.closePath();
}
