/**
 * SF5 repair.
 *
 * Pentafluorosulfanyl is octahedral S(VI), and no general-purpose
 * embedder or force field gets it right: MMFF cannot even type the
 * sulfur, and UFF (which we never use — see CleanupPolicy) collapses the
 * group outright. The group's Python tooling worked around this by
 * pinning an ideal octahedron as an RDKit coordMap before embedding;
 * the same octahedron is applied here as a repair after embedding,
 * which needs no support from the embedder at all.
 *
 * The five fluorines are terminal, so they can be moved freely. The
 * single non-fluorine substituent carries the rest of the molecule, so
 * it is not teleported: the whole fragment hanging off it is translated
 * rigidly along the S→substituent axis to the ideal 1.85 Å.
 */
import { SF5_SF_DISTANCE, SF5_SUBSTITUENT_DISTANCE, type GraphAtom, type MolecularGraph } from "./types";

export interface SF5Group {
  sulfur: number;
  fluorines: number[];
  /** The single non-fluorine neighbour, or null for a bare SF5. */
  substituent: number | null;
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (a: Vec3, k: number): Vec3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const norm = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

function unit(a: Vec3): Vec3 {
  const n = norm(a);
  // A zero vector means the embedder stacked two atoms; any axis will do
  // here — the overlap check downstream is what rejects such a geometry.
  return n === 0 ? { x: 0, y: 0, z: 1 } : scale(a, 1 / n);
}

/** Any unit vector perpendicular to w. */
function perpendicular(w: Vec3): Vec3 {
  const seed = Math.abs(w.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  return unit(cross(w, seed));
}

const pos = (a: GraphAtom): Vec3 => ({ x: a.x, y: a.y, z: a.z });

/** Sulfurs bonded to exactly five fluorines (plus at most one other atom). */
export function findSF5Groups(graph: MolecularGraph): SF5Group[] {
  const out: SF5Group[] = [];
  graph.atoms.forEach((atom, idx) => {
    if (atom.el !== "S") return;
    const fluorines: number[] = [];
    const others: number[] = [];
    for (const n of atom.neighbors) {
      if (graph.atoms[n]?.el === "F") fluorines.push(n);
      else others.push(n);
    }
    if (fluorines.length !== 5 || others.length > 1) return;
    out.push({ sulfur: idx, fluorines, substituent: others[0] ?? null });
  });
  return out;
}

/**
 * Atoms reachable from `start` without passing through `blocked` — the
 * fragment that must move with the substituent.
 */
function fragmentFrom(graph: MolecularGraph, start: number, blocked: number): Set<number> {
  const seen = new Set<number>([start]);
  const stack = [start];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const n of graph.atoms[cur]?.neighbors ?? []) {
      if (n === blocked || seen.has(n)) continue;
      seen.add(n);
      stack.push(n);
    }
  }
  return seen;
}

export interface SF5Repair {
  atoms: GraphAtom[];
  /** How many SF5 groups were rebuilt. */
  repaired: number;
}

/** Rebuilds every SF5 group as an ideal octahedron. */
export function applySF5Geometry(graph: MolecularGraph): SF5Repair {
  const groups = findSF5Groups(graph);
  if (groups.length === 0) return { atoms: graph.atoms, repaired: 0 };

  const atoms = graph.atoms.map((a) => ({ ...a }));
  const working: MolecularGraph = { atoms };

  for (const group of groups) {
    const s = pos(atoms[group.sulfur]!);
    // The local +z axis points at the substituent, so the rest of the
    // molecule keeps its orientation; a bare SF5 gets an arbitrary axis.
    const axis =
      group.substituent === null
        ? { x: 0, y: 0, z: 1 }
        : unit(sub(pos(atoms[group.substituent]!), s));
    const u = perpendicular(axis);
    const v = unit(cross(axis, u));

    // Four equatorial vertices and the one trans to the substituent.
    const vertices: Vec3[] = [
      scale(u, SF5_SF_DISTANCE),
      scale(u, -SF5_SF_DISTANCE),
      scale(v, SF5_SF_DISTANCE),
      scale(v, -SF5_SF_DISTANCE),
      scale(axis, -SF5_SF_DISTANCE),
    ];
    group.fluorines.forEach((f, i) => {
      const p = add(s, vertices[i]!);
      atoms[f] = { ...atoms[f]!, x: p.x, y: p.y, z: p.z };
    });

    if (group.substituent !== null) {
      const current = norm(sub(pos(atoms[group.substituent]!), s));
      const shift = scale(axis, SF5_SUBSTITUENT_DISTANCE - current);
      // Rigid translation of the whole attached fragment: stretching the
      // S–C bond alone would distort everything downstream of it.
      for (const idx of fragmentFrom(working, group.substituent, group.sulfur)) {
        const a = atoms[idx]!;
        atoms[idx] = { ...a, x: a.x + shift.x, y: a.y + shift.y, z: a.z + shift.z };
      }
    }
  }
  return { atoms, repaired: groups.length };
}
