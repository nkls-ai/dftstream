import { hueColor, type Hue } from "../palette";
import type { Theme, ViewerStyle } from "../settingsSchema";
/**
 * Pure style/color tables and key computation for the StructureViewer.
 * No 3Dmol or DOM dependencies — everything here is unit-testable.
 */

export type Style = ViewerStyle;
export type SurfaceKind = "none" | "vdw" | "sas";

/** Isovalue used for +/− orbital lobes. */
export const ISOVAL = 0.04;

/** Van der Waals radii (Å) for pick-highlight sizing. Keys are uppercase. */
export const VDW_RADII: Record<string, number> = {
  H: 1.2,
  C: 1.7,
  N: 1.55,
  O: 1.52,
  F: 1.47,
  P: 1.8,
  S: 1.8,
  CL: 1.75,
  BR: 1.85,
  I: 1.98,
};

/** Named +/− lobe colour sets for isosurfaces (resolved per viewer background). */
export interface OrbitalLobes {
  positive: Hue;
  negative: Hue;
}

export const ORBITAL_LOBES = {
  /** Occupied / generic MOs (HOMO, MO n). */
  occupied: { positive: "teal", negative: "pink" },
  /** LUMO: a visibly different pair so HOMO/LUMO are never confused. */
  lumo: { positive: "violet", negative: "gold" },
  /** Non-orbital property cubes (density, ESP, ...). */
  property: { positive: "cyan", negative: "orange" },
} as const satisfies Record<string, OrbitalLobes>;

export type OrbitalLobeSet = keyof typeof ORBITAL_LOBES;

/** Lobe colours for `set` on a `bg` background; the viewer and its legend share this. */
export function lobeColors(set: OrbitalLobeSet | undefined, bg: Theme): { positive: string; negative: string } {
  const lobes = ORBITAL_LOBES[set ?? "occupied"];
  return { positive: hueColor(lobes.positive, bg), negative: hueColor(lobes.negative, bg) };
}

export function bgColor(bg: Theme): string {
  return bg === "dark" ? "#1a1b1e" : "#f0f4f8";
}

/** Diverging blue(−) / red(+) map for partial charges, clamped to ±1. */
export function chargeToColor(q: number): string {
  const clamped = Math.max(-1, Math.min(1, q));
  const mag = Math.abs(clamped);
  const t = Math.min(1, mag * 2);
  if (clamped >= 0) {
    const r = Math.round(255 * (0.6 + 0.4 * t));
    const g = Math.round(255 * (0.6 - 0.25 * t));
    const b = Math.round(255 * (0.6 - 0.25 * t));
    return `rgb(${r},${g},${b})`;
  }
  const r = Math.round(255 * (0.6 - 0.25 * t));
  const g = Math.round(255 * (0.6 - 0.1 * t));
  const b = Math.round(255 * (0.6 + 0.4 * t));
  return `rgb(${r},${g},${b})`;
}

/** Radius of the halo drawn around a picked atom, sized to clear the atom
 *  as rendered in the current style. */
export function pickedAtomHighlightRadius(elem: string, style: Style): number {
  const vdwRadius = VDW_RADII[elem.toUpperCase()] ?? 1.7;
  if (style === "spacefill") return vdwRadius + 0.22;
  if (style === "ball-stick") return Math.max(0.52, vdwRadius * 0.28 + 0.18);
  return 0.55;
}

/** Everything (besides coordinates) that forces a full scene rebuild. */
export interface SceneConfig {
  style: Style;
  labels: boolean;
  surface: SurfaceKind;
  bg: Theme;
  spinning: boolean;
  /** `${kind}:${id}` of the active orbital, or "" when none. */
  orbKey: string;
  opacity: number;
  colorByCharge: boolean;
  chargesLen: number;
  /** Dipole-arrow overlay key ("" when hidden). */
  dipoleKey?: string;
}

/** Cheap string key over the scene config — used to detect the coordinate-only
 *  fast path (vibration animation, geometry scrubbing) vs. a full rebuild. */
export function sceneConfigKey(c: SceneConfig): string {
  return `${c.style}|${c.labels}|${c.surface}|${c.bg}|${c.spinning}|${c.orbKey}|${c.opacity}|${c.colorByCharge}|${c.chargesLen}|${c.dipoleKey ?? ""}`;
}
