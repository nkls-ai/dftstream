// Pure logic for the Tools tab's file viewer. React-free so it can be unit
// tested directly.

import { parseMultiXYZ, parseXYZFrameEnergy } from "../components/xyz";
import { HARTREE_TO_KCAL } from "../lib/constants";

export interface LoadedTraj {
  frames: string[];
  /** Comment-line energy (Eh) per frame; undefined where absent. */
  energies: (number | undefined)[];
}

export function parseLoadedTraj(text: string): LoadedTraj {
  const frames = parseMultiXYZ(text);
  return { frames, energies: frames.map(parseXYZFrameEnergy) };
}

/** Energy-vs-frame series. Relative mode rebases to the minimum and converts
 *  to kcal/mol; frames without a parsable energy are skipped. */
export function buildToolsEnergySeries(
  energies: (number | undefined)[],
  relative: boolean,
): { x: number; y: number }[] {
  const defined = energies.filter((e): e is number => e != null);
  if (defined.length === 0) return [];
  const min = Math.min(...defined);
  const out: { x: number; y: number }[] = [];
  energies.forEach((e, i) => {
    if (e == null) return;
    out.push({ x: i, y: relative ? (e - min) * HARTREE_TO_KCAL : e });
  });
  return out;
}

export function localFileUrl(path: string): string {
  return `/api/local-file?path=${encodeURIComponent(path)}`;
}

/** Extensions the local-path loader accepts (mirrors the Go allowlist). */
export const LOCAL_FILE_EXTENSIONS = [".xyz", ".trj", ".allxyz", ".interp", ".out"];

export function isSupportedLocalFile(path: string): boolean {
  const lower = path.trim().toLowerCase();
  return LOCAL_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
