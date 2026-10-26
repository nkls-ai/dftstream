import { useCallback, useEffect, useRef, useState } from "react";
import { useSettings } from "../lib/settings";
import { usePointerDrag } from "../hooks/usePointerDrag";
import {
  buildSurfaceScene,
  computeZExtent,
  createProjector,
  findClosestProjected,
  surfaceColorForZ,
  type ProjectedPoint,
} from "../lib/gl/surfaceProjection";
import {
  paintAxes,
  paintHighlights,
  paintMarkers,
  paintQuads,
  syncCanvasBackingStore,
  type SurfaceMarker,
} from "../lib/gl/surfacePaint";

export type { SurfaceMarker } from "../lib/gl/surfacePaint";

/** Hit radius (px) for hover/click point picking. */
const PICK_RADIUS = 20;

interface Props {
  xs: number[];
  ys: number[];
  zGrid: (number | null)[][];
  xLabel?: string;
  yLabel?: string;
  zLabel?: string;
  selectedIdx?: number | null;
  pointIndices: (number | null)[][];
  onSelect?: (idx: number) => void;
  height?: number;
  tooltipFor?: (idx: number) => string | null;
  markers?: SurfaceMarker[];
}

export function Surface3D({
  xs, ys, zGrid, xLabel, yLabel, zLabel,
  selectedIdx, pointIndices, onSelect, height = 380, tooltipFor, markers,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [settings] = useSettings();
  const dark = settings.theme === "dark";
  const [rotation, setRotation] = useState({ rx: -25, ry: 35 });
  const [hovered, setHovered] = useState<number | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; startRx: number; startRy: number } | null>(null);
  const projectedRef = useRef<ProjectedPoint[]>([]);

  const { zMin, zMax, zRange } = computeZExtent(zGrid);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const { w, h } = syncCanvasBackingStore(canvas, ctx, dpr);

    ctx.fillStyle = dark ? "#1e1f22" : "#f5f7fa";
    ctx.fillRect(0, 0, w, h);

    const xMin = xs[0]!, xMax = xs[xs.length - 1]!;
    const yMin = ys[0]!, yMax = ys[ys.length - 1]!;

    const project = createProjector({
      xMin, xMax, yMin, yMax, zMin, zRange,
      rxDeg: rotation.rx, ryDeg: rotation.ry,
      width: w, height: h,
    });

    const { quads, projected } = buildSurfaceScene(
      xs, ys, zGrid, pointIndices, project,
      (z) => surfaceColorForZ(z, zMin, zRange),
    );
    projectedRef.current = projected;

    paintQuads(ctx, quads, dark);
    paintAxes(ctx, { project, xMin, xMax, yMin, yMax, zMin, zMax, dark, xLabel, yLabel, zLabel });

    const markerSet = new Set((markers ?? []).map((m) => m.idx));
    paintMarkers(ctx, markers ?? [], projected, dark);
    paintHighlights(ctx, projected, selectedIdx, hovered, markerSet, dark);
  }, [xs, ys, zGrid, rotation, dark, selectedIdx, hovered, zMin, zMax, zRange, xLabel, yLabel, zLabel, pointIndices, markers]);

  useEffect(() => { draw(); }, [draw]);
  useEffect(() => {
    const onResize = () => draw();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [draw]);

  const onPointerDown = usePointerDrag({
    onStart: (e) => {
      dragRef.current = { startX: e.clientX, startY: e.clientY, startRx: rotation.rx, startRy: rotation.ry };
    },
    onMove: (ev) => {
      if (!dragRef.current) return;
      const dx = ev.clientX - dragRef.current.startX;
      const dy = ev.clientY - dragRef.current.startY;
      setRotation({ rx: dragRef.current.startRx + dy * 0.4, ry: dragRef.current.startRy + dx * 0.4 });
    },
    onEnd: () => {
      dragRef.current = null;
    },
  });

  const onClick = useCallback((e: React.MouseEvent) => {
    if (!onSelect) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const idx = findClosestProjected(
      projectedRef.current, e.clientX - rect.left, e.clientY - rect.top, PICK_RADIUS,
    );
    if (idx != null) onSelect(idx);
  }, [onSelect]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (dragRef.current) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    setHovered(findClosestProjected(
      projectedRef.current, e.clientX - rect.left, e.clientY - rect.top, PICK_RADIUS,
    ));
  }, []);

  const tooltipIdx = hovered;
  const tooltipPoint = tooltipIdx != null
    ? projectedRef.current.find((p) => p.idx === tooltipIdx)
    : null;
  const tooltipText = tooltipIdx != null && tooltipFor ? tooltipFor(tooltipIdx) : null;

  return (
    <div className="surface3d-wrap" style={{ height }}>
      <canvas
        ref={canvasRef}
        className="surface3d-canvas"
        onPointerDown={onPointerDown}
        onClick={onClick}
        onMouseMove={onMouseMove}
        onMouseLeave={() => setHovered(null)}
      />
      {tooltipText && tooltipPoint && (
        <div
          className="surface3d-tooltip"
          style={{
            left: Math.min(tooltipPoint.sx + 12, (canvasRef.current?.clientWidth ?? 400) - 160),
            top: Math.max(8, tooltipPoint.sy - 36),
          }}
        >
          {tooltipText}
        </div>
      )}
      <div className="surface3d-hint dim">
        drag = rotate · click = select point
        <span className="scan-gradient" style={{ display: "inline-block", width: 60, height: 6, marginLeft: 8, verticalAlign: "middle" }} />
        <span style={{ marginLeft: 4 }}>ΔE</span>
      </div>
    </div>
  );
}
