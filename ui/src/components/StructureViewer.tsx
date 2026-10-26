import { useEffect, useRef, useState } from "react";
import * as $3Dmol from "3dmol";
import type { AtomSpec, GLModel, GLViewer } from "3dmol";
import { useSettings, type Theme } from "../lib/settings";
import { reportError } from "../lib/errorReporting";
import {
  bgColor,
  sceneConfigKey,
  type Style,
  type SurfaceKind,
} from "../lib/gl/structureStyle";
import { MEASURE_ATOMS } from "../lib/gl/measure";
import {
  addAtomLabels,
  addDipoleArrow,
  addMolecularSurface,
  addOrbitalIsosurfaces,
  appendTrajectoryFrames,
  applyChargeColors,
  applyStyle,
  clearScene,
  drawMeasurementOverlays,
  orbitalCubeKey,
  orientToPrincipalAxes,
  structureSignature,
  type AtomCharge,
  type OrbitalCube,
  type VolumeCacheEntry,
} from "./gl/structureScene";
import { useMeasurements } from "./gl/useMeasurements";
import { useViewerExport } from "./gl/useViewerExport";
import {
  StructureViewerExportOverlay,
  StructureViewerLegend,
  StructureViewerMeasurements,
} from "./StructureViewerLegend";

export type { AtomCharge, OrbitalCube } from "./gl/structureScene";

interface Props {
  xyz: string;
  /** Pre-parsed animation frames for trajectory mode. All frames are loaded
   *  once via addModelsAsFrames; switching uses setFrame — no re-parse. */
  trajectory?: string[];
  /** Which frame to display (0-based). Only used with trajectory. */
  frameIndex?: number;
  /** Optional list of orbital cube artifacts. When present, a dropdown is
   *  exposed and the chosen orbital is rendered as +/− isosurfaces. */
  orbitals?: OrbitalCube[];
  /** Optional per-atom partial charges for color-by-charge mode. */
  charges?: AtomCharge[];
  /** Optional dipole moment (a.u. vector + Debye magnitude) — exposes a
   *  toolbar toggle that draws μ as an arrow through the molecule center. */
  dipole?: { vec: [number, number, number]; debye: number } | null;
  /** Filename stem for exports (PNG / video / GIF). Defaults to "structure". */
  exportFileStem?: string;
  /** Per-frame labels (e.g. "cycle5") parallel to `trajectory`, used to name
   *  the single-frame PNG export. */
  frameLabels?: string[];
}

export function StructureViewer({ xyz, trajectory, frameIndex, orbitals, charges, dipole, exportFileStem, frameLabels }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<GLViewer | null>(null);
  const [settings] = useSettings();
  const [style, setStyle] = useState<Style>(settings.viewerStyle);
  const [surface, setSurface] = useState<SurfaceKind>("none");
  const [labels, setLabels] = useState(false);
  const [spinning, setSpinning] = useState(settings.viewerSpin);
  const [bg, setBg] = useState<Theme>(settings.theme);
  const [orbitalKind, setOrbitalKind] = useState<string | null>(null);
  const [opacity, setOpacity] = useState(0.55);
  const [colorByCharge, setColorByCharge] = useState(false);
  const [showDipole, setShowDipole] = useState(false);
  const dipoleKey =
    showDipole && dipole ? `${dipole.vec.join(",")}:${dipole.debye}` : "";
  const {
    measureMode,
    setMeasureMode,
    pickedAtoms,
    measurements,
    handleAtomClick,
    removeMeasurement,
    clearMeasurements,
  } = useMeasurements(xyz);
  const prevXyzRef = useRef<string>("");
  const prevConfigRef = useRef<string>("");
  const volumeRef = useRef<VolumeCacheEntry | null>(null);
  const modelRef = useRef<GLModel | null>(null);
  const trajKeyRef = useRef<string>("");
  const frameIndexRef = useRef(frameIndex ?? 0);
  frameIndexRef.current = frameIndex ?? 0;
  const appliedFrameRef = useRef(-1);
  // Signature of the system the camera was last oriented for. Rebuilds for
  // a style toggle or a new frame of the same molecule keep the user's
  // rotation; a different molecule gets the principal-axis default again.
  const orientedSigRef = useRef("");
  const orientOnce = (v: GLViewer, frame: string) => {
    const sig = structureSignature(frame);
    if (sig === orientedSigRef.current) return;
    orientToPrincipalAxes(v, frame);
    orientedSigRef.current = sig;
  };

  // If the set of available orbital *kinds* changes (e.g. cubes appear /
  // disappear), default to the first. We key the selection by kind
  // ("homo" / "lumo") not artifact id so scrubbing across opt cycles
  // keeps the same orbital active even though the underlying cube ids
  // differ per cycle.
  useEffect(() => {
    if (!orbitals || orbitals.length === 0) {
      setOrbitalKind(null);
      return;
    }
    if (!orbitalKind || !orbitals.find((o) => o.kind === orbitalKind)) {
      setOrbitalKind(orbitals[0]!.kind);
    }
  }, [orbitals, orbitalKind]);

  const activeOrbital = orbitals?.find((o) => o.kind === orbitalKind) ?? null;

  // Create the viewer once.
  useEffect(() => {
    if (!containerRef.current || viewerRef.current) return;
    const v = $3Dmol.createViewer(containerRef.current, {
      backgroundColor: bgColor(bg),
    });
    viewerRef.current = v;
    return () => {
      try {
        v.spin?.(false);
        v.removeAllModels();
        v.clear?.();
      } catch { /* best-effort GL resource cleanup */ }
      try {
        v.getCanvas?.().remove();
      } catch { /* canvas may already be detached */ }
      viewerRef.current = null;
      modelRef.current = null;
      trajKeyRef.current = "";
      appliedFrameRef.current = -1;
      orientedSigRef.current = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── TRAJECTORY MODE ──
  // Load frame 0 with addModel (proven path), then build cloned frame
  // arrays with updated positions for setFrame-based switching.
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || !trajectory || trajectory.length === 0) return;

    // orbitalCubeKey includes the body length: the orbital entry exists (same
    // kind/id) while its body is still loading, and the scene must rebuild
    // once the body arrives or the isosurface is silently never drawn.
    const orbKey = activeOrbital ? orbitalCubeKey(activeOrbital) : "";
    const config = sceneConfigKey({
      style, labels, surface, bg, spinning, orbKey, opacity, colorByCharge,
      chargesLen: charges?.length ?? 0, dipoleKey,
    });
    const newKey = `${trajectory.length}:${(trajectory[0] ?? "").length}|${config}`;
    if (newKey === trajKeyRef.current) return;

    try {
      clearScene(v);

      const model = v.addModel(trajectory[0], "xyz");
      modelRef.current = model;
      applyStyle(v, style);

      if (colorByCharge && charges && charges.length > 0) {
        applyChargeColors(v, model, charges);
      }

      model.setClickable({}, true, (atom: AtomSpec) => { handleAtomClick(atom); });

      appendTrajectoryFrames(model, trajectory);

      if (labels) addAtomLabels(v, model, bg);
      if (surface !== "none") addMolecularSurface(v, surface, bg);

      if (activeOrbital && activeOrbital.cube && activeOrbital.cube.length > 0) {
        addOrbitalIsosurfaces(v, activeOrbital, bg, opacity, volumeRef, "render isosurface (trajectory)");
      }

      if (showDipole && dipole) addDipoleArrow(v, model, dipole.vec, dipole.debye);

      v.setBackgroundColor(bgColor(bg), 1);
      v.zoomTo();
      orientOnce(v, trajectory[0]!);
      v.spin?.(spinning ? "y" : false);

      const fi = frameIndexRef.current;
      if (fi > 0 && model.getNumFrames() > fi) model.setFrame(fi);
      appliedFrameRef.current = fi;
      v.render();
      trajKeyRef.current = newKey;
    } catch (err) {
      reportError(err, { source: "structure-viewer", action: "load trajectory" });
    }
  }, [trajectory, style, labels, surface, bg, spinning, activeOrbital, opacity, colorByCharge, charges, dipole, showDipole, dipoleKey, handleAtomClick]);

  // Fast frame switching — setFrame swaps atom array, render rebuilds GL.
  // Skip if trajectory loading already rendered this exact frame.
  useEffect(() => {
    if (!trajectory || trajectory.length === 0 || frameIndex == null) return;
    if (appliedFrameRef.current === frameIndex) return;
    const v = viewerRef.current;
    const model = modelRef.current;
    if (!v || !model || model.getNumFrames() <= frameIndex) return;
    model.setFrame(frameIndex);
    appliedFrameRef.current = frameIndex;
    v.render();
  }, [frameIndex, trajectory]);

  // ── SINGLE-XYZ MODE ──
  // Rebuild scene on input change. Fast path when only xyz changed
  // (vibration animation, geometry scrubbing) — skips surfaces,
  // isosurfaces, labels, zoomTo for ~10x speedup per frame.
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || !xyz) return;
    if (trajectory && trajectory.length > 0) return;

    const orbKey = activeOrbital ? orbitalCubeKey(activeOrbital) : "";
    const configKey = sceneConfigKey({
      style, labels, surface, bg, spinning, orbKey, opacity, colorByCharge,
      chargesLen: charges?.length ?? 0, dipoleKey,
    });
    const configChanged = configKey !== prevConfigRef.current;
    const xyzChanged = xyz !== prevXyzRef.current;
    prevConfigRef.current = configKey;
    // NOTE(preserved-behavior): prevXyzRef is never written, so the fast
    // path below can never trigger (its `!== ""` guard always fails). This
    // matches the pre-refactor behavior exactly; enabling the fast path
    // would change what renders (it skips labels/surfaces/zoomTo), so it
    // is intentionally left as-is by this refactor.

    try {
      if (xyzChanged && !configChanged && prevXyzRef.current !== "") {
        // FAST PATH: only coordinates changed — swap model, preserve camera
        v.removeAllModels();
        const model = v.addModel(xyz, "xyz");
        applyStyle(v, style);
        if (colorByCharge && charges && charges.length > 0) {
          applyChargeColors(v, model, charges);
        }
        model.setClickable({}, true, (atom: AtomSpec) => {
          handleAtomClick(atom);
        });
        v.render();
        return;
      }

      // FULL REBUILD
      clearScene(v);

      const model = v.addModel(xyz, "xyz");
      applyStyle(v, style);

      if (colorByCharge && charges && charges.length > 0) {
        applyChargeColors(v, model, charges);
      }

      if (labels) addAtomLabels(v, model, bg);
      if (surface !== "none") addMolecularSurface(v, surface, bg);

      if (activeOrbital && activeOrbital.cube && activeOrbital.cube.length > 0) {
        addOrbitalIsosurfaces(v, activeOrbital, bg, opacity, volumeRef, "render isosurface");
      }

      if (showDipole && dipole) addDipoleArrow(v, model, dipole.vec, dipole.debye);

      model.setClickable({}, true, (atom: AtomSpec) => {
        handleAtomClick(atom);
      });

      v.setBackgroundColor(bgColor(bg), 1);
      v.zoomTo();
      orientOnce(v, xyz);
      v.spin?.(spinning ? "y" : false);
      v.render();
    } catch (err) {
      reportError(err, {
        source: "structure-viewer",
        action: "render molecule",
      });
    }
  }, [xyz, trajectory, style, labels, surface, bg, spinning, activeOrbital, opacity, colorByCharge, charges, dipole, showDipole, dipoleKey, handleAtomClick]);

  // Draw measurement overlays (shapes + labels) without rebuilding the full scene.
  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;

    v.removeAllShapes?.();
    v.removeAllLabels?.();

    // Re-add atom labels if they were on
    if (labels) {
      const model = v.getModel() as GLModel | undefined;
      if (model) addAtomLabels(v, model, bg);
    }

    drawMeasurementOverlays(v, pickedAtoms, measurements, style);

    v.render();
  }, [pickedAtoms, measurements, labels, bg, style]);

  const resetView = () => {
    const v = viewerRef.current;
    if (!v) return;
    v.zoomTo();
    const frame = trajectory?.[frameIndex ?? 0] ?? trajectory?.[0] ?? xyz;
    if (frame) orientToPrincipalAxes(v, frame);
    v.render();
  };

  const {
    menuOpen,
    setMenuOpen,
    exporting,
    menuRef,
    hasTrajectory,
    videoSupported,
    videoExt,
    exportPng,
    exportVideo,
  } = useViewerExport({
    viewerRef,
    modelRef,
    frameIndexRef,
    trajectory,
    spinning,
    exportFileStem,
    frameLabels,
  });

  return (
    <div className="mol-shell">
      <div className="mol-toolbar">
        <div className="mol-tool">
          <label className="dim" htmlFor="mol-style-select">Style</label>
          <select
            id="mol-style-select"
            value={style}
            onChange={(e) => setStyle(e.target.value as Style)}
          >
            <option value="ball-stick">Ball &amp; stick</option>
            <option value="stick">Stick</option>
            <option value="line">Line</option>
            <option value="spacefill">Space-fill</option>
          </select>
        </div>
        <div className="mol-tool">
          <label className="dim" htmlFor="mol-surface-select">Surface</label>
          <select
            id="mol-surface-select"
            value={surface}
            onChange={(e) => setSurface(e.target.value as SurfaceKind)}
          >
            <option value="none">None</option>
            <option value="vdw">van der Waals</option>
            <option value="sas">Solvent-accessible</option>
          </select>
        </div>
        {orbitals && orbitals.length > 0 && (
          <>
            <div className="mol-tool">
              <label className="dim" htmlFor="mol-orbital-select">Orbital</label>
              <select
                id="mol-orbital-select"
                value={orbitalKind ?? ""}
                onChange={(e) => setOrbitalKind(e.target.value || null)}
              >
                <option value="">None</option>
                {Array.from(
                  new Map(orbitals.map((o) => [o.kind, o])).values(),
                ).map((o) => (
                  <option key={o.kind} value={o.kind}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            {activeOrbital && (
              <div className="mol-tool" title="Isosurface opacity">
                <span className="dim">Opacity</span>
                <input aria-label="Isosurface opacity"
                  type="range"
                  min={0.15}
                  max={0.95}
                  step={0.05}
                  value={opacity}
                  onChange={(e) => setOpacity(Number(e.target.value))}
                  style={{ width: 80 }}
                />
              </div>
            )}
          </>
        )}
        {charges && charges.length > 0 && (
          <button type="button"
            className={"mol-btn" + (colorByCharge ? " active" : "")}
            onClick={() => setColorByCharge((x) => !x)}
            onMouseUp={(e) => (e.currentTarget as HTMLButtonElement).blur()}
            title="Color atoms by partial charge (blue − / red +)"
          >
            Charges
          </button>
        )}
        {dipole && (
          <button type="button"
            className={"mol-btn" + (showDipole ? " active" : "")}
            onClick={() => setShowDipole((x) => !x)}
            onMouseUp={(e) => (e.currentTarget as HTMLButtonElement).blur()}
            title={`Show dipole moment arrow (|μ| = ${dipole.debye.toFixed(2)} D)`}
          >
            μ Dipole
          </button>
        )}
        <div className="mol-tool">
          <label className="dim" htmlFor="mol-measure-select">Measure</label>
          <select
            id="mol-measure-select"
            value={measureMode}
            onChange={(e) => setMeasureMode(e.target.value as typeof measureMode)}
          >
            <option value="off">Off</option>
            <option value="distance">Distance (2)</option>
            <option value="angle">Angle (3)</option>
            <option value="dihedral">Dihedral (4)</option>
          </select>
        </div>
        {measurements.length > 0 && (
          <button type="button"
            className="mol-btn"
            onClick={clearMeasurements}
            onMouseUp={(e) => (e.currentTarget as HTMLButtonElement).blur()}
            title="Clear all measurements"
          >
            Clear
          </button>
        )}
        <button type="button"
          className={"mol-btn" + (labels ? " active" : "")}
          onClick={() => setLabels((x) => !x)}
          onMouseUp={(e) => (e.currentTarget as HTMLButtonElement).blur()}
        >
          Labels
        </button>
        <button type="button"
          className={"mol-btn" + (spinning ? " active" : "")}
          onClick={() => setSpinning((x) => !x)}
          onMouseUp={(e) => (e.currentTarget as HTMLButtonElement).blur()}
          title="Continuous rotation around Y"
        >
          {spinning ? "⏸ Spin" : "↻ Spin"}
        </button>
        <button type="button"
          className="mol-btn"
          onClick={resetView}
          onMouseUp={(e) => (e.currentTarget as HTMLButtonElement).blur()}
        >
          Reset view
        </button>
        <button type="button"
          className="mol-btn"
          onClick={() => setBg(bg === "dark" ? "light" : "dark")}
          onMouseUp={(e) => (e.currentTarget as HTMLButtonElement).blur()}
          title="Toggle background"
        >
          {bg === "dark" ? "☀ Light" : "🌙 Dark"}
        </button>
        <div className="mol-export" ref={menuRef}>
          <button type="button"
            className={"mol-btn mol-dots-btn" + (menuOpen ? " active" : "")}
            onClick={() => setMenuOpen((o) => !o)}
            disabled={Boolean(exporting)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="Export image or animation"
            title="Export image / animation"
          >
            {exporting ? `${Math.round(exporting.fraction * 100)}%` : "⋮"}
          </button>
          {menuOpen && (
            <div className="mol-menu" role="menu">
              <button type="button" className="mol-menu-item" role="menuitem" onClick={exportPng}>
                <span>Save PNG</span>
                <span className="mol-menu-sub">this frame</span>
              </button>
              {videoSupported && (
                <button type="button" className="mol-menu-item" role="menuitem" onClick={exportVideo}>
                  <span>Record video</span>
                  <span className="mol-menu-sub">
                    {hasTrajectory ? "trajectory" : "360° spin"} · .{videoExt}
                  </span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="mol-viewer-wrap">
        <div ref={containerRef} className="mol-viewer" />
        <StructureViewerExportOverlay exporting={exporting} />
      </div>
      <StructureViewerLegend
        atomsToPick={measureMode !== "off" ? MEASURE_ATOMS[measureMode] - pickedAtoms.length : null}
        activeOrbital={activeOrbital}
        viewerBg={bg}
        colorByCharge={colorByCharge}
        dipoleDebye={showDipole && dipole ? dipole.debye : null}
      />
      <StructureViewerMeasurements measurements={measurements} onRemove={removeMeasurement} />
    </div>
  );
}
