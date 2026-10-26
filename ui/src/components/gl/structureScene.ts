/**
 * 3Dmol scene plumbing for the StructureViewer: everything that mutates the
 * GLViewer/GLModel lives here as small, order-preserving helpers. The
 * component keeps the effect sequencing; these functions keep the GL calls.
 */
import * as $3Dmol from "3dmol";
import type { AtomSpec, GLModel, GLViewer } from "3dmol";
import { reportError } from "../../lib/errorReporting";
import { parseXYZPositions } from "../xyz";
import {
  ISOVAL,
  chargeToColor,
  lobeColors,
  pickedAtomHighlightRadius,
  type OrbitalLobeSet,
  type Style,
  type SurfaceKind,
} from "../../lib/gl/structureStyle";
import { midpoint } from "../../lib/geometry";
import { principalViewQuaternion } from "../../lib/gl/principalView";
import type { Measurement, PickedAtom } from "../../lib/gl/measure";
import type { Theme } from "../../lib/settings";

/** A single volumetric (cube) artifact ready to be rendered as an isosurface. */
export interface OrbitalCube {
  /** Stable identifier for React/key purposes (e.g. artifact id). */
  id: string;
  /** Stable "kind" key (e.g. "homo", "lumo") used by the dropdown selection
   *  so flipping between opt cycles keeps the same orbital active. */
  kind: string;
  /** Short label shown in the toolbar dropdown ("HOMO", "LUMO", "HOMO−1"...). */
  label: string;
  /** Raw Gaussian cube text. */
  cube: string;
  /** Lobe colour set (default "occupied"); resolved against the viewer background. */
  lobes?: OrbitalLobeSet;
}

export interface AtomCharge {
  idx: number;
  element: string;
  charge: number;
}

/** Cached parsed VolumeData keyed on the orbital's stable `${kind}:${id}`. */
export interface VolumeCacheEntry {
  key: string;
  data: InstanceType<typeof $3Dmol.VolumeData>;
}

/** Highlight/measure accent color shared by halos, cylinders, and labels. */
export const MEASURE_COLOR = "#fbbf24";

/** Stops spin and removes labels, surfaces, shapes, and models. */
export function clearScene(v: GLViewer): void {
  v.spin?.(false);
  v.removeAllLabels?.();
  v.removeAllSurfaces?.();
  v.removeAllShapes?.();
  v.removeAllModels();
}

export function applyStyle(v: GLViewer, style: Style): void {
  v.setStyle({}, {});
  switch (style) {
    case "ball-stick":
      v.setStyle({}, { stick: { radius: 0.15 }, sphere: { scale: 0.28 } });
      break;
    case "stick":
      v.setStyle({}, { stick: { radius: 0.18 } });
      break;
    case "line":
      v.setStyle({}, { line: { linewidth: 2 } });
      break;
    case "spacefill":
      v.setStyle({}, { sphere: {} });
      break;
  }
}

export function applyChargeColors(v: GLViewer, model: GLModel, charges: AtomCharge[]): void {
  const atoms = model.selectedAtoms({});
  for (let i = 0; i < atoms.length && i < charges.length; i++) {
    const color = chargeToColor(charges[i]!.charge);
    v.setStyle({ index: i }, { sphere: { scale: 0.32, color }, stick: { radius: 0.15, color } });
  }
}

export function atomDisplayIndex(atom: AtomSpec): number {
  return (atom.serial ?? atom.index ?? 0) + 1;
}

export function isPickableAtom(atom: AtomSpec | null | undefined): atom is AtomSpec {
  return atom?.x != null && atom.y != null && atom.z != null && (atom.serial != null || atom.index != null);
}

export function addAtomLabels(v: GLViewer, model: GLModel, bg: Theme): void {
  const atoms = model.selectedAtoms({});
  atoms.forEach((a: AtomSpec) => {
    if (a.x == null || a.y == null || a.z == null) return;
    v.addLabel(`${a.elem ?? "?"}${atomDisplayIndex(a)}`, {
      position: { x: a.x, y: a.y, z: a.z },
      backgroundColor:
        bg === "dark" ? "rgba(0, 0, 0, 0.55)" : "rgba(255, 255, 255, 0.92)",
      fontColor: bg === "dark" ? "#d4d7de" : "#1a2332",
      borderColor: "#5cb4ff",
      borderThickness: 0.4,
      fontSize: 11,
    });
  });
}

/** Adds a translucent VDW or SAS molecular surface. */
export function addMolecularSurface(
  v: GLViewer,
  surface: Exclude<SurfaceKind, "none">,
  bg: Theme,
): void {
  const type = surface === "vdw" ? $3Dmol.SurfaceType.VDW : $3Dmol.SurfaceType.SAS;
  v.addSurface(type, { opacity: 0.35, color: bg === "dark" ? "#5cb4ff" : "#1D7DCA" });
}

/**
 * Draws the molecular dipole as an arrow from the geometric center of the
 * molecule along μ. Arrow length scales with |μ| (clamped so tiny and huge
 * dipoles both stay visible); by convention the arrow points from − to +
 * charge, i.e. along the dipole-moment vector ORCA prints.
 */
export function addDipoleArrow(
  v: GLViewer,
  model: GLModel,
  vecAU: [number, number, number],
  debye: number,
): void {
  const [dx, dy, dz] = vecAU;
  const norm = Math.hypot(dx, dy, dz);
  if (norm === 0) return;
  const atoms = model.selectedAtoms({});
  if (atoms.length === 0) return;
  let cx = 0, cy = 0, cz = 0;
  for (const a of atoms) {
    cx += a.x ?? 0;
    cy += a.y ?? 0;
    cz += a.z ?? 0;
  }
  cx /= atoms.length;
  cy /= atoms.length;
  cz /= atoms.length;
  const lengthA = Math.min(Math.max(debye * 0.8, 1.0), 5.0);
  const ux = (dx / norm) * lengthA;
  const uy = (dy / norm) * lengthA;
  const uz = (dz / norm) * lengthA;
  v.addArrow({
    start: { x: cx - ux / 2, y: cy - uy / 2, z: cz - uz / 2 },
    end: { x: cx + ux / 2, y: cy + uy / 2, z: cz + uz / 2 },
    radius: 0.09,
    radiusRatio: 2.4,
    mid: 0.82,
    color: "#fbbf24",
  });
}

/**
 * Cache/scene key for an orbital cube. The stable kind:id part disambiguates
 * opt cycles (which often produce cubes of identical character length, so
 * length alone is not a safe key); the length part forces a rebuild/reparse
 * when the same artifact's body grows mid-download (chunked upload streaming
 * in through a reactive query).
 */
export function orbitalCubeKey(orbital: OrbitalCube): string {
  return `${orbital.kind}:${orbital.id}:${orbital.cube.length}`;
}

/**
 * Adds the +/− orbital lobes as isosurfaces, parsing (and caching) the cube.
 * The cache is keyed by `orbitalCubeKey` (see its doc for why kind, id, and
 * body length are all required). Parse/render failures are reported (with
 * `errorAction` naming the call site), never thrown — a bad cube must not
 * take down the molecule render.
 */
export function addOrbitalIsosurfaces(
  v: GLViewer,
  orbital: OrbitalCube,
  bg: Theme,
  opacity: number,
  cache: { current: VolumeCacheEntry | null },
  errorAction: string,
): void {
  try {
    const cubeKey = orbitalCubeKey(orbital);
    let voldata = cache.current?.key === cubeKey ? cache.current.data : null;
    if (!voldata) {
      voldata = new $3Dmol.VolumeData(orbital.cube, "cube");
      cache.current = { key: cubeKey, data: voldata };
    }
    const { positive: pos, negative: neg } = lobeColors(orbital.lobes, bg);
    v.addIsosurface(voldata, { isoval: ISOVAL, color: pos, opacity, smoothness: 5 });
    v.addIsosurface(voldata, { isoval: -ISOVAL, color: neg, opacity, smoothness: 5 });
  } catch (err) {
    reportError(err, { source: "structure-viewer", action: errorAction });
  }
}

/**
 * Builds frame arrays for fast setFrame switching. Clones frame 0's atoms
 * (which have styles, bonds, clickable set) and swaps in each subsequent
 * frame's coordinates — 3Dmol stores styles per-atom, so cloning from the
 * styled frame 0 ensures every frame renders correctly.
 */
export function appendTrajectoryFrames(model: GLModel, trajectory: string[]): void {
  if (trajectory.length <= 1) return;
  const frame0 = model.selectedAtoms({});
  // 3Dmol's GLModel typings keep `frames` private even though the
  // library mutates it as public API; narrow-cast just that property.
  const modelFrames = (model as unknown as { frames: AtomSpec[][] }).frames;
  for (let fi = 1; fi < trajectory.length; fi++) {
    const positions = parseXYZPositions(trajectory[fi]!);
    const cloned = frame0.map((a, i) => {
      const pos = positions[i];
      return { ...a, x: pos?.[0] ?? a.x, y: pos?.[1] ?? a.y, z: pos?.[2] ?? a.z };
    });
    modelFrames.push(cloned);
  }
}

/** Draws a picked atom as a visible halo outside the rendered atom. */
export function addPickedAtomHighlight(
  v: GLViewer,
  atom: PickedAtom,
  style: Style,
  color: string,
): void {
  const radius = pickedAtomHighlightRadius(atom.elem, style);
  v.addSphere({ center: atom.pos, radius, color, opacity: 0.32, quality: 2 });
  v.addSphere({ center: atom.pos, radius: radius + 0.03, color, opacity: 0.95, wireframe: true, quality: 2 });
}

/**
 * Draws pick halos for in-progress picks plus cylinders + a midpoint label
 * for each completed measurement. Caller is responsible for clearing shapes
 * and re-rendering.
 */
export function drawMeasurementOverlays(
  v: GLViewer,
  pickedAtoms: PickedAtom[],
  measurements: Measurement[],
  style: Style,
): void {
  const labelStyle = {
    backgroundColor: "rgba(0,0,0,0.7)",
    fontColor: MEASURE_COLOR,
    fontSize: 11,
    borderRadius: 3,
    padding: 2,
  };

  for (const a of pickedAtoms) {
    addPickedAtomHighlight(v, a, style, MEASURE_COLOR);
  }

  for (const m of measurements) {
    for (let i = 0; i < m.atoms.length - 1; i++) {
      v.addCylinder({
        start: m.atoms[i]!.pos,
        end: m.atoms[i + 1]!.pos,
        radius: 0.05,
        color: MEASURE_COLOR,
        fromCap: 1,
        toCap: 1,
      });
    }
    // Label at midpoint of first–last atom
    const first = m.atoms[0]!.pos;
    const last = m.atoms[m.atoms.length - 1]!.pos;
    const mid = midpoint(first, last);
    v.addLabel(m.label, {
      position: mid,
      ...labelStyle,
    });
  }
}

/**
 * Turns the model so its principal axes face the screen (largest spread
 * left-right, smallest towards the viewer), keeping zoomTo's centre and
 * zoom. Without it a linear molecule laid out along z shows as one sphere.
 */
export function orientToPrincipalAxes(v: GLViewer, xyz: string): void {
  const q = principalViewQuaternion(parseXYZPositions(xyz));
  const view = v.getView() as number[];
  if (view.length < 8) return;
  v.setView([view[0], view[1], view[2], view[3], ...q, ...view.slice(8)]);
}

/** Atom count + element sequence: same value across frames of one system. */
export function structureSignature(xyz: string): string {
  return xyz
    .split("\n")
    .slice(2)
    .map((l) => l.trim().split(/\s+/)[0] ?? "")
    .filter(Boolean)
    .join(",");
}
