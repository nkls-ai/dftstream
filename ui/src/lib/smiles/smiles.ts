/**
 * SMILES → a structure ready for an ORCA input.
 *
 * Pipeline (ported from the group's `geometry.py`):
 *   parse → seeded 3D embed → SF5 octahedron repair → force-field
 *   cleanup, unless the molecule is one no force field can type →
 *   overlap validation
 *
 * Charge and multiplicity come from the SMILES itself, so a
 * `[O-]C(=O)C` or a `C[CH2]` lands in the builder with the right
 * `* xyz -1 1` / `* xyz 0 2` header instead of a silent default.
 */
import { loadEmbedBackend, type EmbedBackend } from "./backend";
import { finishMolecule } from "./embed";
import { SmilesErrorKind, type SmilesResult } from "./types";

/** Embeds a SMILES using an already-loaded backend. */
export function smilesTo3DWith(backend: EmbedBackend, smiles: string): SmilesResult {
  const trimmed = smiles.trim();
  if (!trimmed) {
    return { ok: false, error: { kind: SmilesErrorKind.Parse, message: "no SMILES given" } };
  }
  const embedded = backend.embed(trimmed);
  if ("error" in embedded) return { ok: false, error: embedded.error };

  const finished = finishMolecule(embedded.graph, {
    smiles: trimmed,
    cleanupApplied: embedded.cleanup,
    backendNote: embedded.note,
  });
  if ("error" in finished) return { ok: false, error: finished.error };
  return { ok: true, molecule: finished.molecule };
}

/**
 * Embeds a SMILES, loading the chemistry toolkit on first use. Never
 * rejects: a backend that fails to load comes back as a typed error the
 * UI can show.
 */
export async function smilesTo3D(smiles: string): Promise<SmilesResult> {
  const backend = await loadEmbedBackend();
  if ("kind" in backend) return { ok: false, error: backend };
  return smilesTo3DWith(backend, smiles);
}

/** A molfile / SDF record → a structure, using an already-loaded backend. */
export function molfileTo3DWith(backend: EmbedBackend, molfile: string, label: string): SmilesResult {
  if (!molfile.trim()) {
    return { ok: false, error: { kind: SmilesErrorKind.Parse, message: "the file is empty" } };
  }
  const embedded = backend.embedMolfile(firstSDFRecord(molfile));
  if ("error" in embedded) return { ok: false, error: embedded.error };

  const finished = finishMolecule(embedded.graph, {
    smiles: label,
    cleanupApplied: embedded.cleanup,
    backendNote: embedded.note,
  });
  if ("error" in finished) return { ok: false, error: finished.error };
  return { ok: true, molecule: finished.molecule };
}

/**
 * A molfile / SDF file → a structure, loading the toolkit on first use.
 * `label` is the provenance shown to the user (normally the file name).
 */
export async function molfileTo3D(molfile: string, label: string): Promise<SmilesResult> {
  const backend = await loadEmbedBackend();
  if ("kind" in backend) return { ok: false, error: backend };
  return molfileTo3DWith(backend, molfile, label);
}

/**
 * The first record of an SDF. An .sdf is a concatenation of molfiles
 * separated by `$$$$`; a builder input is one molecule, and silently
 * concatenating a 500-compound library into one "molecule" is the worst
 * possible reading.
 */
export function firstSDFRecord(text: string): string {
  const end = text.search(/^\$\$\$\$\s*$/m);
  return end === -1 ? text : text.slice(0, end);
}

/** Whether an SDF holds more than one record (the UI says so). */
export function sdfRecordCount(text: string): number {
  return (text.match(/^\$\$\$\$\s*$/gm) ?? []).length || 1;
}
