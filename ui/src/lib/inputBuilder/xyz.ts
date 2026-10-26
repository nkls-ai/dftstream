/**
 * Reads a structure from pasted text or an uploaded file.
 *
 * Deliberately tolerant, because chemists paste all of it: a proper
 * .xyz with its count/comment header, a bare block of `El x y z` rows
 * copied out of an ORCA output, or an ORCA coordinate block still
 * wrapped in `* xyz 0 1 … *`. What it refuses to do is guess: a row it
 * cannot read is reported, never skipped silently.
 */
import { normalizeElement } from "./elements";
import { StructureSource, type Atom, type Structure } from "./types";

export interface ParsedStructure {
  structure: Structure | null;
  /** Charge/multiplicity when the text carried an ORCA `* xyz C M` header. */
  charge: number | null;
  multiplicity: number | null;
  errors: string[];
}

const COORD_HEADER = /^\s*\*\s*(xyz|xyzfile|gzmt|int)\s+(-?\d+)\s+(\d+)/i;
const ATOM_ROW = /^\s*([A-Za-z]{1,2})\s+(-?\d*\.?\d+(?:[eE][-+]?\d+)?)\s+(-?\d*\.?\d+(?:[eE][-+]?\d+)?)\s+(-?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*$/;

export function parseStructureText(
  text: string,
  source: StructureSource,
  label = "",
): ParsedStructure {
  const errors: string[] = [];
  const atoms: Atom[] = [];
  let charge: number | null = null;
  let multiplicity: number | null = null;

  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let start = 0;
  // A leading atom count + comment line is the standard .xyz header.
  const declared = Number((lines[0] ?? "").trim());
  if (Number.isInteger(declared) && declared > 0 && !ATOM_ROW.test(lines[0] ?? "")) {
    start = 2;
  }

  for (let i = start; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const header = COORD_HEADER.exec(raw);
    if (header) {
      charge = Number(header[2]);
      multiplicity = Number(header[3]);
      continue;
    }
    if (line === "*") continue; // closing an ORCA coordinate block
    const m = ATOM_ROW.exec(raw);
    if (!m) {
      errors.push(`line ${i + 1}: cannot read "${line.slice(0, 60)}" as "El x y z"`);
      continue;
    }
    atoms.push({
      el: normalizeElement(m[1]!),
      x: Number(m[2]),
      y: Number(m[3]),
      z: Number(m[4]),
    });
  }

  if (atoms.length === 0) {
    errors.push("no atoms found — expected .xyz text or `El x y z` rows");
    return { structure: null, charge, multiplicity, errors };
  }
  if (start === 2 && declared !== atoms.length) {
    errors.push(`header says ${declared} atoms, found ${atoms.length}`);
  }
  return { structure: { atoms, source, label }, charge, multiplicity, errors };
}

/** Smallest pairwise distance in Å; Infinity for fewer than two atoms. */
export function minPairwiseDistance(atoms: Atom[]): number {
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

/** Molecular formula in Hill order, for labelling a loaded structure. */
export function molecularFormula(atoms: Atom[]): string {
  const counts = new Map<string, number>();
  for (const a of atoms) counts.set(a.el, (counts.get(a.el) ?? 0) + 1);
  // Hill order: with carbon it is C, H, then the rest alphabetically;
  // without carbon every symbol (H included) sorts alphabetically.
  const order = counts.has("C")
    ? ["C", ...(counts.has("H") ? ["H"] : []), ...[...counts.keys()].filter((el) => el !== "C" && el !== "H").sort()]
    : [...counts.keys()].sort();
  return order.map((el) => `${el}${counts.get(el)! > 1 ? counts.get(el) : ""}`).join("");
}
