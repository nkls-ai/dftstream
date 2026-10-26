/**
 * SMILES → 3D: the domain rules, ported from the group's own
 * `OrcaTools/orcatools/geometry.py`. The constants below are not
 * defaults to tune — each one is a scar from a geometry that came out
 * wrong.
 */

/** Fixed embedding seed, so the same SMILES always gives the same
 *  starting geometry (and the same run is reproducible). */
export const EMBED_SEED = 6767;

/**
 * Smallest allowed pairwise distance (Å). Embedders can silently
 * compress or stack hypervalent groups; below this the geometry is
 * rejected rather than handed to ORCA.
 */
export const MIN_VALID_ATOM_DISTANCE = 0.7;

/** Ideal S–F distance of an octahedral SF5 group (Å). */
export const SF5_SF_DISTANCE = 1.58;

/** Distance to the single non-fluorine substituent of an SF5 (Å). */
export const SF5_SUBSTITUENT_DISTANCE = 1.85;

/**
 * How the embedded geometry is cleaned up.
 *
 * There is deliberately no UFF option: UFF has no parameters for
 * hypervalent centres and collapses them — an SF5 group comes back with
 * S–F distances near 0 Å. Falling back to it "just to get something" is
 * how a molecule silently turns into nonsense.
 */
export enum CleanupPolicy {
  /** MMFF94 minimization — only when every atom can be typed. */
  ForceField = "force-field",
  /** Keep the embedded coordinates as they are. */
  None = "none",
}

/** Why a SMILES could not be turned into a usable structure. */
export enum SmilesErrorKind {
  Parse = "parse",
  Embed = "embed",
  Overlap = "overlap",
  BackendUnavailable = "backend-unavailable",
}

export interface SmilesError {
  kind: SmilesErrorKind;
  message: string;
}

export interface GraphAtom {
  el: string;
  x: number;
  y: number;
  z: number;
  charge: number;
  /** Unpaired electrons on this atom (radical state). */
  unpaired: number;
  /** Indices of the atoms bonded to it. */
  neighbors: number[];
}

/** The embedder's output: atoms with 3D coordinates and connectivity. */
export interface MolecularGraph {
  atoms: GraphAtom[];
}

/** A finished structure, ready to become an ORCA coordinate block. */
export interface Molecule3D {
  atoms: { el: string; x: number; y: number; z: number }[];
  charge: number;
  multiplicity: number;
  smiles: string;
  /** Non-fatal notes for the user (cleanup skipped, SF5 repaired, …). */
  notes: string[];
}

export type SmilesResult =
  | { ok: true; molecule: Molecule3D }
  | { ok: false; error: SmilesError };
