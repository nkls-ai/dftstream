import { useChartColors } from "../lib/chartColors";
import { ISOVAL, lobeColors } from "../lib/gl/structureStyle";
import type { Measurement } from "../lib/gl/measure";
import type { Theme } from "../lib/settings";
import type { OrbitalCube } from "./gl/structureScene";

// Presentational pieces of the StructureViewer around the 3Dmol canvas:
// the export progress overlay, the hint/legend line under the canvas and
// the measurement tags. Text colours come from the theme palette (the
// legend sits on the app background); the lobe swatches use the viewer
// background so they match the isosurfaces actually drawn.

export function StructureViewerExportOverlay({
  exporting,
}: {
  exporting: { label: string; fraction: number } | null;
}) {
  if (!exporting) return null;
  const pct = Math.round(exporting.fraction * 100);
  return (
    <div className="mol-export-overlay" role="status" aria-live="polite">
      <div className="mol-export-card">
        <div className="mol-export-label">{exporting.label}</div>
        <div className="mol-export-bar">
          <div className="mol-export-bar-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="dim mol-export-pct">{pct}%</div>
      </div>
    </div>
  );
}

export function StructureViewerLegend({
  atomsToPick,
  activeOrbital,
  viewerBg,
  colorByCharge,
  dipoleDebye,
}: {
  /** Atoms still to click for the active measurement; null when measuring is off. */
  atomsToPick: number | null;
  activeOrbital: OrbitalCube | null;
  viewerBg: Theme;
  colorByCharge: boolean;
  /** |μ| in Debye while the dipole arrow is shown, else null. */
  dipoleDebye: number | null;
}) {
  const c = useChartColors();
  const lobes = activeOrbital ? lobeColors(activeOrbital.lobes, viewerBg) : null;
  return (
    <div className="mol-hint dim">
      drag = rotate · scroll = zoom · shift-drag = pan
      {atomsToPick != null && (
        <span style={{ marginLeft: 12, color: c.hue("gold") }}>
          · click {atomsToPick} more atom{atomsToPick !== 1 ? "s" : ""}
        </span>
      )}
      {lobes && (
        <span style={{ marginLeft: 12 }}>
          · isosurface |ψ| = {ISOVAL.toFixed(2)} ·{" "}
          <span style={{ color: lobes.positive }}>+ lobe</span>{" "}
          /{" "}
          <span style={{ color: lobes.negative }}>− lobe</span>
        </span>
      )}
      {colorByCharge && (
        <span style={{ marginLeft: 12 }}>
          · charge map:{" "}
          <span style={{ color: c.hue("blue") }}>blue −</span>{" / "}
          <span style={{ color: c.hue("red") }}>red +</span>
        </span>
      )}
      {dipoleDebye != null && (
        <span style={{ marginLeft: 12 }}>
          · <span style={{ color: c.hue("gold") }}>→ μ</span> |μ| ={" "}
          {dipoleDebye.toFixed(2)} D (arrow − → +)
        </span>
      )}
    </div>
  );
}

export function StructureViewerMeasurements({
  measurements,
  onRemove,
}: {
  measurements: Measurement[];
  onRemove: (index: number) => void;
}) {
  if (measurements.length === 0) return null;
  return (
    <div className="mol-measurements">
      {measurements.map((m, i) => (
        <span
          key={`${m.mode}-${m.atoms.map((a) => a.index).join("-")}`}
          className="mol-measurement-tag"
          onClick={() => onRemove(i)}
          title="Click to remove"
        >
          {m.label}
        </span>
      ))}
    </div>
  );
}
