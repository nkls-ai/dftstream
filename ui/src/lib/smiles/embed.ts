/**
 * The embedding pipeline, backend-independent and pure:
 *
 *   graph → SF5 repair → cleanup policy → overlap validation → molecule
 *
 * Everything here is a rule from the group's `geometry.py`; the actual
 * conformer generation lives behind the backend (see backend.ts).
 */
import { applySF5Geometry, findSF5Groups } from "./sf5";
import {
  CleanupPolicy,
  MIN_VALID_ATOM_DISTANCE,
  SmilesErrorKind,
  type Molecule3D,
  type MolecularGraph,
  type SmilesError,
} from "./types";

/**
 * MMFF is used only when the molecule has no SF5 group: the force field
 * cannot type hypervalent sulfur, and the one alternative every toolkit
 * offers — UFF — collapses SF5 to overlapping atoms. Leaving the
 * embedded coordinates alone is strictly better than "cleaning" them
 * with a force field that does not know the chemistry; the DFT
 * optimization refines them anyway.
 */
export function chooseCleanup(hasSF5: boolean): CleanupPolicy {
  return hasSF5 ? CleanupPolicy.None : CleanupPolicy.ForceField;
}

/** Formal charge of the whole molecule. */
export function totalCharge(graph: MolecularGraph): number {
  return graph.atoms.reduce((sum, a) => sum + a.charge, 0);
}

/** Spin multiplicity (2S+1) from the radical electrons the SMILES declares. */
export function multiplicity(graph: MolecularGraph): number {
  return graph.atoms.reduce((sum, a) => sum + a.unpaired, 0) + 1;
}

/** Smallest pairwise distance (Å); Infinity for fewer than two atoms. */
export function minPairwiseDistance(atoms: { x: number; y: number; z: number }[]): number {
  let best = Infinity;
  for (let i = 0; i < atoms.length; i++) {
    for (let j = i + 1; j < atoms.length; j++) {
      const a = atoms[i]!;
      const b = atoms[j]!;
      const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      if (d < best) best = d;
    }
  }
  return best;
}

/**
 * Rejects a geometry whose atoms overlap. An embedder that stacks atoms
 * produces an input ORCA will chew on for hours before failing (or,
 * worse, converge to something meaningless), so this is a hard refusal,
 * not a warning.
 */
export function validateGeometry(atoms: { x: number; y: number; z: number }[], smiles: string): SmilesError | null {
  const min = minPairwiseDistance(atoms);
  if (min < MIN_VALID_ATOM_DISTANCE) {
    return {
      kind: SmilesErrorKind.Overlap,
      message:
        `overlapping atoms in "${smiles}" (min pairwise distance ${min.toFixed(3)} Å < ` +
        `${MIN_VALID_ATOM_DISTANCE} Å) — the embedder could not build this group cleanly`,
    };
  }
  return null;
}

export interface FinishOptions {
  smiles: string;
  /** Whether the backend actually ran a force-field cleanup. */
  cleanupApplied: CleanupPolicy;
  /** A note from the backend (e.g. the force field refused to type an atom). */
  backendNote?: string;
}

/**
 * Turns an embedded graph into the finished molecule: SF5 repair,
 * charge/multiplicity, overlap check.
 */
export function finishMolecule(graph: MolecularGraph, opts: FinishOptions): { molecule: Molecule3D } | { error: SmilesError } {
  const notes: string[] = [];
  if (opts.backendNote) notes.push(opts.backendNote);

  const { atoms, repaired } = applySF5Geometry(graph);
  if (repaired > 0) {
    notes.push(
      `${repaired} SF5 group${repaired > 1 ? "s" : ""} rebuilt as an ideal octahedron — no force field ` +
        `parameterizes hypervalent sulfur, so the embedded geometry cannot be trusted there`,
    );
  }
  if (opts.cleanupApplied === CleanupPolicy.None && repaired === 0) {
    notes.push("force-field cleanup was skipped — the DFT optimization will refine the geometry");
  }

  const plain = atoms.map((a) => ({ el: a.el, x: a.x, y: a.y, z: a.z }));
  const overlap = validateGeometry(plain, opts.smiles);
  if (overlap) return { error: overlap };

  return {
    molecule: {
      atoms: plain,
      charge: totalCharge({ atoms }),
      multiplicity: multiplicity({ atoms }),
      smiles: opts.smiles,
      notes,
    },
  };
}

/** Whether a graph contains an SF5 group (drives the cleanup choice). */
export function hasSF5(graph: MolecularGraph): boolean {
  return findSF5Groups(graph).length > 0;
}
