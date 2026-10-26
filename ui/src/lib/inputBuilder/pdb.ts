/**
 * Minimal PDB coordinate extraction: ATOM / HETATM records → atoms.
 *
 * The PDB format is column-based, not whitespace-delimited, and real
 * files break the whitespace assumption constantly (four-character atom
 * names touch the residue name, negative coordinates touch each other).
 * So the columns of the format spec are what is read:
 *
 *   13-16 atom name    17 altLoc     18-20 resName
 *   31-38 x   39-46 y  47-54 z
 *   77-78 element
 *
 * The element symbol comes from columns 77-78 when present (it is the
 * only authoritative field); otherwise it is derived from the atom name,
 * which is where a "CA" calcium/α-carbon mix-up would come from — so
 * that fallback is reported as a note, never silently trusted.
 */
import { isKnownElement, normalizeElement } from "./elements";
import { StructureSource, type Atom, type Structure } from "./types";

export interface ParsedPDB {
  structure: Structure | null;
  errors: string[];
  /** Non-fatal remarks: guessed elements, skipped alternate locations, … */
  notes: string[];
}

/** Character columns (1-based, inclusive) of the fields we read. */
const COL = {
  name: [13, 16],
  altLoc: [17, 17],
  x: [31, 38],
  y: [39, 46],
  z: [47, 54],
  element: [77, 78],
} as const;

function field(line: string, [from, to]: readonly [number, number]): string {
  return line.slice(from - 1, to).trim();
}

/** The field with its padding intact — the atom name's columns carry meaning. */
function rawField(line: string, [from, to]: readonly [number, number]): string {
  return line.slice(from - 1, to).padEnd(to - from + 1, " ");
}

/**
 * Element from the atom-name field, which must be passed WITH its
 * padding: the PDB convention right-justifies single-letter elements in
 * columns 13-14, so " CA " is an α-carbon and "CA  " is calcium — the
 * space is the whole distinction. Returns "" when nothing plausible
 * comes out.
 */
export function elementFromAtomName(paddedName: string): string {
  const twoChar = paddedName.slice(0, 2);
  if (/^[A-Za-z]{2}$/.test(twoChar)) {
    const el = normalizeElement(twoChar);
    if (isKnownElement(el)) return el;
  }
  const letters = paddedName.replace(/[^A-Za-z]/g, "");
  if (!letters) return "";
  const one = normalizeElement(letters[0]!);
  return isKnownElement(one) ? one : "";
}

export function parsePDB(text: string, label = ""): ParsedPDB {
  const errors: string[] = [];
  const notes: string[] = [];
  const atoms: Atom[] = [];
  let guessedElements = 0;
  let skippedAltLoc = 0;

  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const records = lines.map((l) => l.slice(0, 6).trim().toUpperCase());
  // Counted up front, because parsing stops at the first ENDMDL and would
  // otherwise never learn that an NMR ensemble's other 19 models exist.
  const models = records.filter((r) => r === "MODEL").length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const record = records[i]!;
    // Only the first model is read: an ensemble would otherwise arrive
    // as one 20×-sized "molecule".
    if (record === "ENDMDL") break;
    if (record !== "ATOM" && record !== "HETATM") continue;

    // Alternate conformations: keep A (and blank), drop the rest rather
    // than stacking two positions of the same atom on top of each other.
    const altLoc = field(line, COL.altLoc);
    if (altLoc !== "" && altLoc.toUpperCase() !== "A") {
      skippedAltLoc++;
      continue;
    }

    const xs = field(line, COL.x);
    const ys = field(line, COL.y);
    const zs = field(line, COL.z);
    const x = Number(xs);
    const y = Number(ys);
    const z = Number(zs);
    if (xs === "" || ys === "" || zs === "" || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      errors.push(`line ${i + 1}: cannot read coordinates from "${line.slice(0, 60)}"`);
      continue;
    }

    const rawName = rawField(line, COL.name);
    let el = field(line, COL.element);
    if (el) {
      el = normalizeElement(el);
      if (!isKnownElement(el)) {
        errors.push(`line ${i + 1}: element column says "${el}", which is not an element symbol`);
        continue;
      }
    } else {
      el = elementFromAtomName(rawName);
      if (!el) {
        errors.push(`line ${i + 1}: no element column and atom name "${rawName.trim()}" is not an element`);
        continue;
      }
      guessedElements++;
    }
    atoms.push({ el, x, y, z });
  }

  if (models > 1) {
    notes.push("the file holds several models — only the first was read");
  }
  if (skippedAltLoc > 0) {
    notes.push(`${skippedAltLoc} alternate-location atom${skippedAltLoc > 1 ? "s were" : " was"} skipped (kept conformation A)`);
  }
  if (guessedElements > 0) {
    notes.push(
      `${guessedElements} atom${guessedElements > 1 ? "s have" : " has"} no element column — the symbol was taken from the atom name; check the metals`,
    );
  }
  if (atoms.length === 0) {
    errors.push("no ATOM or HETATM records found");
    return { structure: null, errors, notes };
  }
  if (atoms.length > 0 && !atoms.some((a) => a.el === "H")) {
    notes.push("no hydrogens in the file — crystallographic PDBs usually omit them, and ORCA will not add them");
  }
  return {
    structure: { atoms, source: StructureSource.File, label },
    errors,
    notes,
  };
}
