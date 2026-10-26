/**
 * Which parser reads which uploaded structure file, and the one entry
 * point the UI calls. Keeping the dispatch here (rather than in the
 * component) means "what can I upload?" has a single answer, shared by
 * the file picker's accept list and the adopt path.
 */
import { parsePDB } from "./pdb";
import { parseStructureText } from "./xyz";
import { StructureSource, type Structure } from "./types";

/** Structure file formats the builder reads. */
export enum StructureFormat {
  XYZ = "xyz",
  /** MDL molfile / SDF — parsed by the chemistry toolkit. */
  Molfile = "molfile",
  PDB = "pdb",
}

/** `accept` attribute of the upload input. */
export const STRUCTURE_FILE_ACCEPT = ".xyz,.txt,.mol,.sdf,.mdl,.pdb,.ent";

const EXTENSIONS: Readonly<Record<string, StructureFormat>> = {
  xyz: StructureFormat.XYZ,
  txt: StructureFormat.XYZ,
  mol: StructureFormat.Molfile,
  sdf: StructureFormat.Molfile,
  mdl: StructureFormat.Molfile,
  pdb: StructureFormat.PDB,
  ent: StructureFormat.PDB,
};

/** Format of a file name, or null when the extension is not one we read. */
export function formatForFileName(name: string): StructureFormat | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return EXTENSIONS[ext] ?? null;
}

export interface LoadedStructure {
  structure: Structure | null;
  charge: number | null;
  multiplicity: number | null;
  errors: string[];
  notes: string[];
}

/**
 * Reads a structure file whose format needs no chemistry toolkit (xyz,
 * pdb). Molfiles go through `molfileTo3D` instead — they need the
 * toolkit's valence model for hydrogens, charge and spin — so this
 * returns an error for them rather than half-reading the connection
 * table.
 */
export function loadStructureFile(
  text: string,
  fileName: string,
  format: StructureFormat,
): LoadedStructure {
  switch (format) {
    case StructureFormat.PDB: {
      const parsed = parsePDB(text, fileName);
      return {
        structure: parsed.structure,
        charge: null,
        multiplicity: null,
        errors: parsed.errors,
        notes: parsed.notes,
      };
    }
    case StructureFormat.Molfile:
      return {
        structure: null,
        charge: null,
        multiplicity: null,
        errors: ["a molfile needs the chemistry toolkit — call molfileTo3D for this format"],
        notes: [],
      };
    case StructureFormat.XYZ:
    default: {
      const parsed = parseStructureText(text, StructureSource.File, fileName);
      return {
        structure: parsed.structure,
        charge: parsed.charge,
        multiplicity: parsed.multiplicity,
        errors: parsed.errors,
        notes: [],
      };
    }
  }
}
