// Pure data-shaping helpers for the run Structure tab: opt-cycle energy
// series, per-cycle orbital cube selection, vib-mode maps and the small
// colour-map math behind the charge/bond-order widgets. No React here so
// everything stays unit-testable.
import type { OrbitalCube } from "../components/StructureViewer";
import type { CubeMeta, VibBlob } from "../data/DataSource";
import type { Geometry, MetricPoint } from "../data/types";
import { displayBasename } from "./runDetailArtifacts";
import {
  extractCubeCycle,
  extractMOIndex,
  extractVibModeIndex,
} from "./runDetailParsers";
import type { OrbitalLobeSet } from "../lib/gl/structureStyle";

/** Geometries sorted by opt cycle (input order from the backend is by ts). */
export function sortGeometriesByCycle(
  geoms: Geometry[] | undefined,
): Geometry[] {
  return geoms ? [...geoms].sort((a, b) => a.cycle - b.cycle) : [];
}

/** Energy-per-cycle chart series: one point per cycle (last value wins),
 *  restricted to cycles we actually have a geometry for (unless there are
 *  no geometry cycles at all), sorted by cycle. */
export function buildEnergyData(
  points: MetricPoint[] | undefined,
  geomCycles: ReadonlySet<number>,
): { x: number; y: number }[] {
  const byKey = new Map<number, number>();
  for (const p of (points ?? []).filter(
    (p) => geomCycles.size === 0 || geomCycles.has(p.cycle ?? 0),
  )) {
    byKey.set(p.cycle ?? 0, p.value);
  }
  return [...byKey.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([x, y]) => ({ x, y }));
}

/** mode index → displacement-trajectory text, for vib artifacts whose name
 *  encodes a mode index. */
export function buildVibModeMap(
  vibs: VibBlob[] | undefined,
): Map<number, string> {
  const m = new Map<number, string>();
  for (const v of vibs ?? []) {
    const mode = extractVibModeIndex(v.name);
    if (mode != null) m.set(mode, v.contentText);
  }
  return m;
}

/** True when any cube filename carries an opt-cycle index. */
export function hasPerCycleCubes(cubes: CubeMeta[] | undefined): boolean {
  return (cubes ?? []).some((c) => extractCubeCycle(c.name) != null);
}

export interface CubeCycleEntry {
  id: string;
  mo: number;
  name: string;
}

export type CubeCycleKey = number | "final";

/** Build cycle → [HOMO id, LUMO id] map from the cube index. When per-cycle
 *  is off there's just one entry under "final". Deduped by MO index. */
export function buildCubeIdsByCycle(
  cubes: CubeMeta[] | undefined,
): Map<CubeCycleKey, CubeCycleEntry[]> {
  const m = new Map<CubeCycleKey, CubeCycleEntry[]>();
  for (const c of cubes ?? []) {
    const mo = extractMOIndex(c.name);
    if (mo == null) continue;
    const cyc = extractCubeCycle(c.name);
    const key: CubeCycleKey = cyc == null ? "final" : cyc;
    const arr = m.get(key) ?? [];
    if (!arr.some((e) => e.mo === mo))
      arr.push({ id: c.id, mo, name: c.name });
    m.set(key, arr);
  }
  return m;
}

export interface ActiveCubeIds {
  homoId: string | null;
  lumoId: string | null;
  homoName: string;
  lumoName: string;
}

/** Resolve which two cubes (HOMO + LUMO) belong to the displayed cycle:
 *  exact cycle match → nearest numeric cycle → "final" fallback. */
export function resolveActiveCubeIds(
  cubeIdsByCycle: Map<CubeCycleKey, CubeCycleEntry[]>,
  target: number | undefined,
): ActiveCubeIds {
  if (cubeIdsByCycle.size === 0)
    return { homoId: null, lumoId: null, homoName: "", lumoName: "" };
  let entry = target != null ? cubeIdsByCycle.get(target) : undefined;
  if (!entry) {
    const numericKeys = Array.from(cubeIdsByCycle.keys()).filter(
      (k): k is number => typeof k === "number",
    );
    if (numericKeys.length) {
      let best = numericKeys[0]!;
      let bestDiff = Math.abs(best - (target ?? 0));
      for (const k of numericKeys) {
        const d = Math.abs(k - (target ?? 0));
        if (d < bestDiff) {
          best = k;
          bestDiff = d;
        }
      }
      entry = cubeIdsByCycle.get(best);
    }
  }
  if (!entry) entry = cubeIdsByCycle.get("final");
  if (!entry || entry.length === 0) {
    return { homoId: null, lumoId: null, homoName: "", lumoName: "" };
  }
  const sorted = [...entry].sort((a, b) => a.mo - b.mo);
  const homo = sorted[0]!;
  const lumo = sorted[1] ?? sorted[0]!;
  return {
    homoId: homo.id,
    lumoId: lumo === homo ? null : lumo.id,
    homoName: homo.name,
    lumoName: lumo.name,
  };
}

/** Non-orbital cubes (density, ESP, Fukui, ...) — no MO index in the
 *  filename. Newest first, capped at 4 (they're only present when
 *  explicitly computed, so count is low). */
export function pickNonOrbitalCubes(cubes: CubeMeta[] | undefined): CubeMeta[] {
  return (cubes ?? [])
    .filter((c) => extractMOIndex(c.name) == null)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 4);
}

/** Viewer entry for an orbital cube. The entry is created even while its
 *  body is still loading (empty cube string) so the toolbar dropdown +
 *  opacity slider don't flicker as the loop advances through opt cycles.
 *  Returns null when there is no cube id to show. */
export function buildOrbitalEntry(
  id: string | null,
  name: string,
  body: string | undefined,
  homoMO: number | undefined,
  lumoMO: number | undefined,
): OrbitalCube | null {
  if (!id) return null;
  const mo = extractMOIndex(name);
  let label = name;
  let kind = mo != null ? `mo${mo}` : name;
  let lobes: OrbitalLobeSet = "occupied";
  if (mo != null && homoMO != null && mo === homoMO) {
    label = `HOMO (MO ${mo})`;
    kind = "homo";
  } else if (mo != null && lumoMO != null && mo === lumoMO) {
    label = `LUMO (MO ${mo})`;
    kind = "lumo";
    lobes = "lumo";
  } else if (mo != null) {
    label = `MO ${mo}`;
  }
  return { id, kind, label, cube: body ?? "", lobes };
}

/** Viewer entry for a non-orbital (property) cube. */
export function buildExtraCube(
  c: CubeMeta,
  body: string | undefined,
): OrbitalCube {
  const label = displayBasename(c.name).replace(/\.cube$/i, "");
  return {
    id: c.id,
    kind: `prop-${label}`,
    label,
    cube: body ?? "",
    lobes: "property",
  };
}

/** True when the input echo starts a relaxed surface scan block. */
export function isScanInput(inputText: string | undefined): boolean {
  return /^\s*Scan\b/im.test(inputText ?? "");
}

/** Diverging colour-map for an atom's partial charge: charge ∈ [-1,+1]
 *  mapped to blue↔pink with intensity scaled by magnitude. Border tints in
 *  the same hue at a lower alpha so neutral atoms still have a visible
 *  boundary. */
export function atomTileColors(charge: number): { bg: string; border: string } {
  const clamped = Math.max(-1, Math.min(1, charge));
  const mag = Math.abs(clamped);
  const isPos = clamped >= 0;
  const bg = isPos
    ? `rgba(244, 114, 182, ${0.10 + 0.50 * mag})`
    : `rgba(96, 165, 250, ${0.10 + 0.50 * mag})`;
  const border = isPos
    ? `rgba(244, 114, 182, ${0.32 + 0.30 * mag})`
    : `rgba(96, 165, 250, ${0.32 + 0.30 * mag})`;
  return { bg, border };
}

/** Bar geometry for a Mayer bond order: full bar at order 3, minimum 8%
 *  so tiny orders stay visible; "strong" (≥1.5) switches the bar colour. */
export function bondOrderBar(order: number): {
  barWidth: string;
  isStrong: boolean;
} {
  const strength = Math.min(1, order / 3);
  return {
    barWidth: `${Math.max(8, strength * 100)}%`,
    isStrong: order >= 1.5,
  };
}
