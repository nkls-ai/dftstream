import { useEffect, useMemo, useState } from "react";
import { EnergyChart } from "../components/EnergyChart";
import { Surface3D } from "../components/Surface3D";
import type { CriticalPoint, ScanPoint, ScanSummary } from "./scan";
import { buildScanSurfaceGrid, minScanEnergy, sameCoord, uniqueSorted } from "./scanSurface";
import { useEhFormatter, useRelEnergyFormat } from "../lib/useEnergyFormat";
import type { Hue } from "../lib/chartColors";

const CRIT_HUES: Record<CriticalPoint["kind"], Hue> = { minimum: "teal", maximum: "red", saddle: "gold" };
const CRIT_LABELS: Record<CriticalPoint["kind"], string> = { minimum: "Min", maximum: "Max", saddle: "TS?" };

// Renders the scan surface: a 1D energy curve, or a 2D/3D surface with an
// optional slice selector when the scan has three coordinates.
export function ScanSurfacePlot({
  summary,
  points,
  selectedIdx,
  onSelect,
  criticalPoints,
}: {
  summary: ScanSummary;
  points: ScanPoint[];
  selectedIdx: number;
  onSelect: (idx: number) => void;
  criticalPoints: CriticalPoint[];
}) {
  const dims = Math.min(3, Math.max(1, summary.dimensions));
  const selected = points[selectedIdx];
  const [xDim, setXDim] = useState(0);
  const [yDim, setYDim] = useState(1);
  const [zDim, setZDim] = useState(2);
  const [zValue, setZValue] = useState<number | null>(null);
  const fmtEh = useEhFormatter();
  const rel = useRelEnergyFormat();

  useEffect(() => {
    if (xDim >= dims) setXDim(0);
    if (yDim >= dims || yDim === xDim) setYDim(Math.min(1, dims - 1));
    if (zDim >= dims || zDim === xDim || zDim === yDim) {
      const next = [0, 1, 2].find((i) => i < dims && i !== xDim && i !== yDim) ?? 2;
      setZDim(next);
    }
  }, [dims, xDim, yDim, zDim]);

  const activeZDim = dims >= 3 ? zDim : null;
  const zValues = useMemo(
    () => activeZDim == null ? [] : uniqueSorted(points.map((p) => p.coords[activeZDim] ?? 0)),
    [activeZDim, points],
  );

  useEffect(() => {
    if (activeZDim == null) {
      setZValue(null);
      return;
    }
    const preferred = selected?.coords[activeZDim];
    if (preferred != null && zValues.some((v) => sameCoord(v, preferred))) {
      setZValue(Number(preferred.toFixed(8)));
      return;
    }
    if (zValue == null || !zValues.some((v) => sameCoord(v, zValue))) {
      setZValue(zValues[0] ?? null);
    }
  }, [activeZDim, selected, zValue, zValues]);

  const visiblePoints = activeZDim == null
    ? points
    : points.filter((p) => sameCoord(p.coords[activeZDim], zValue));
  const xs = uniqueSorted(visiblePoints.map((p) => p.coords[xDim] ?? 0));
  const ys = uniqueSorted(visiblePoints.map((p) => p.coords[yDim] ?? 0));
  const minE = minScanEnergy(points);

  const { zGrid: zGridKcal, idxGrid } = useMemo(
    () => buildScanSurfaceGrid({ visiblePoints, xs, ys, xDim, yDim, points, minE }),
    [visiblePoints, xs, ys, xDim, yDim, points, minE],
  );
  // The grid is built in kcal/mol; the surface shows the user's unit.
  const zGrid = useMemo(
    () => zGridKcal.map((row) => row.map((z) => (z == null ? null : rel.fromKcal(z)))),
    [zGridKcal, rel],
  );

  if (dims <= 1) {
    return (
      <EnergyChart
        data={points.map((p) => ({ x: p.coordValue, y: p.energy }))}
        xLabel={summary.coordinates[0]?.label ?? summary.coordLabel}
        yLabel="Energy (Eh)"
        height={340}
        markerX={selected?.coordValue ?? null}
        markerLabel={selected ? selected.coordValue.toFixed(3) : undefined}
        onClickPoint={onSelect}
        annotations={criticalPoints.map((cp) => ({
          x: points[cp.idx]!.coordValue,
          y: points[cp.idx]!.energy,
          label: CRIT_LABELS[cp.kind],
          hue: CRIT_HUES[cp.kind],
        }))}
      />
    );
  }

  return (
    <div className="scan-surface">
      {dims >= 3 && activeZDim != null && (
        <div className="scan-axis-controls">
          <label>
            <span>Slice</span>
            <select value={zValue ?? ""} onChange={(e) => setZValue(Number(e.target.value))}>
              {zValues.map((value) => (
                <option key={value} value={value}>
                  {summary.coordinates[activeZDim]?.label ?? "Z"} = {value.toFixed(4)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <Surface3D
        xs={xs}
        ys={ys}
        zGrid={zGrid}
        xLabel={summary.coordinates[xDim]?.label}
        yLabel={summary.coordinates[yDim]?.label}
        zLabel={`ΔE (${rel.label})`}
        selectedIdx={selectedIdx}
        pointIndices={idxGrid}
        onSelect={onSelect}
        height={400}
        tooltipFor={(idx) => {
          const p = points[idx];
          if (!p) return null;
          const lines = [
            `Step ${p.step}`,
            ...summary.coordinates.map((c, ci) => `${c.label}: ${p.coords[ci]?.toFixed(4) ?? "?"}`),
            `E: ${fmtEh(p.energy)} Eh`,
            `ΔE: ${rel.format(p.energy - minE)} ${rel.label}`,
          ];
          return lines.join("\n");
        }}
        markers={criticalPoints.map((cp) => ({
          idx: cp.idx,
          kind: cp.kind,
          label: cp.kind === "minimum" ? "Min" : cp.kind === "maximum" ? "Max" : "Saddle",
        }))}
      />
    </div>
  );
}
