/**
 * The 3D embedding backend, loaded lazily so the chemistry toolkit
 * (~2.5 MB of code plus its torsion/force-field tables) is fetched only
 * when someone actually types a SMILES.
 *
 * Why openchemlib and not RDKit: the published `@rdkit/rdkit` package is
 * RDKit's *MinimalLib* build, and it contains no distance-geometry code
 * at all — `RDKit_minimal.wasm` has no ETKDG, no DistGeom and no MMFF
 * symbols, and `index.d.ts` exposes only 2D depiction coordinates
 * (`set_new_coords`). It cannot embed a 3D conformer. openchemlib ships
 * a seeded conformer generator and MMFF94, which is what the pipeline
 * needs; the backend sits behind this interface so RDKit can be swapped
 * in the day a WASM build with DistGeom is published.
 *
 * The domain rules (seed, SF5 handling, never UFF, overlap rejection)
 * live in embed.ts / sf5.ts and are backend-independent.
 */
import { chooseCleanup, hasSF5 } from "./embed";
import {
  CleanupPolicy,
  EMBED_SEED,
  SmilesErrorKind,
  type GraphAtom,
  type MolecularGraph,
  type SmilesError,
} from "./types";

export interface EmbeddedGraph {
  graph: MolecularGraph;
  cleanup: CleanupPolicy;
  note?: string;
}

export interface EmbedBackend {
  embed(smiles: string): EmbeddedGraph | { error: SmilesError };
  /**
   * A molfile / SDF record → the same embedded graph. A record that
   * already carries 3D coordinates keeps them (that conformer is the
   * reason the file exists); a flat 2D drawing is embedded like a
   * SMILES.
   */
  embedMolfile(molfile: string): EmbeddedGraph | { error: SmilesError };
}

type OCLModule = typeof import("openchemlib");
type OCLMolecule = InstanceType<OCLModule["Molecule"]>;

let backendPromise: Promise<EmbedBackend | SmilesError> | null = null;

/**
 * Loads (once) and returns the embedding backend, or a typed error when
 * the toolkit cannot be fetched — an offline browser must get a clear
 * message, not an unhandled rejection.
 */
export function loadEmbedBackend(): Promise<EmbedBackend | SmilesError> {
  if (!backendPromise) {
    backendPromise = createBackend().catch((err: unknown) => ({
      kind: SmilesErrorKind.BackendUnavailable,
      message: `could not load the 3D chemistry toolkit: ${errorText(err)}`,
    }));
  }
  return backendPromise;
}

/** Drops the cached backend. Test seam; also lets a failed load retry. */
export function resetEmbedBackend(): void {
  backendPromise = null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function createBackend(): Promise<EmbedBackend> {
  const ocl = await import("openchemlib");
  // The conformer generator and MMFF94 read their tables from
  // openchemlib's static resources. The package's exports map hides
  // them, so the file is imported by path — bundled into this lazy
  // chunk, never fetched at runtime.
  const resources = (await import("../../../node_modules/openchemlib/dist/resources.json"))
    .default as Record<string, string>;
  ocl.Resources.register(resources);
  return new OpenChemLibBackend(ocl);
}

class OpenChemLibBackend implements EmbedBackend {
  constructor(private readonly ocl: OCLModule) {}

  embed(smiles: string): EmbeddedGraph | { error: SmilesError } {
    let parsed: OCLMolecule;
    try {
      parsed = this.ocl.Molecule.fromSmiles(smiles);
    } catch (err: unknown) {
      return { error: { kind: SmilesErrorKind.Parse, message: `cannot parse SMILES "${smiles}": ${errorText(err)}` } };
    }
    return this.embedMolecule(parsed, `SMILES "${smiles}"`);
  }

  embedMolfile(molfile: string): EmbeddedGraph | { error: SmilesError } {
    let parsed: OCLMolecule;
    try {
      parsed = this.ocl.Molecule.fromMolfile(molfile);
    } catch (err: unknown) {
      return { error: { kind: SmilesErrorKind.Parse, message: `cannot parse the molfile: ${errorText(err)}` } };
    }
    if (parsed.getAllAtoms() === 0) {
      return { error: { kind: SmilesErrorKind.Parse, message: "the molfile contains no atoms" } };
    }
    // A record that already has 3D coordinates is taken as-is: it is
    // somebody's chosen conformer, and re-embedding would discard it.
    if (isThreeD(molfile, parsed)) {
      const graph = this.toGraph(parsed);
      return {
        graph,
        cleanup: CleanupPolicy.None,
        note: "the file's own 3D coordinates were kept — no conformer was generated",
      };
    }
    return this.embedMolecule(parsed, "the molfile");
  }

  /** Shared tail of every entry point: embed → SF5 gate → MMFF94. */
  private embedMolecule(parsed: OCLMolecule, what: string): EmbeddedGraph | { error: SmilesError } {
    let embedded: OCLMolecule | null;
    try {
      // Fixed seed: the same input must always give the same geometry,
      // or a rerun of "the same" calculation silently isn't one.
      embedded = new this.ocl.ConformerGenerator(EMBED_SEED).getOneConformerAsMolecule(parsed);
    } catch (err: unknown) {
      return { error: { kind: SmilesErrorKind.Embed, message: `3D embedding failed for ${what}: ${errorText(err)}` } };
    }
    if (!embedded) {
      return {
        error: {
          kind: SmilesErrorKind.Embed,
          message: `3D embedding failed for ${what} — no collision-free conformer was found`,
        },
      };
    }

    const embeddedGraph = this.toGraph(embedded);
    if (chooseCleanup(hasSF5(embeddedGraph)) === CleanupPolicy.None) {
      return {
        graph: embeddedGraph,
        cleanup: CleanupPolicy.None,
        note: "force field skipped: it cannot type hypervalent sulfur (and UFF, the usual fallback, collapses SF5)",
      };
    }
    // minimise() moves the atoms in place, so the graph is re-read after
    // it; on a refusal the coordinates are simply the embedded ones.
    const note = this.minimize(embedded);
    return {
      graph: this.toGraph(embedded),
      cleanup: note ? CleanupPolicy.None : CleanupPolicy.ForceField,
      note,
    };
  }

  /** Runs MMFF94; returns a note when the force field refused the molecule. */
  private minimize(mol: OCLMolecule): string | undefined {
    try {
      const ff = new this.ocl.ForceFieldMMFF94(mol, "MMFF94");
      const rc = ff.minimise();
      if (rc !== 0) {
        return `MMFF94 minimization did not converge (code ${rc}) — using the embedded geometry`;
      }
      return undefined;
    } catch (err: unknown) {
      // Typing failures are expected for exotic valences; the embedded
      // geometry is the honest answer, never a UFF "repair".
      return `MMFF94 could not type this molecule (${errorText(err)}) — using the embedded geometry`;
    }
  }

  private toGraph(mol: OCLMolecule): MolecularGraph {
    const count = mol.getAllAtoms();
    const atoms: GraphAtom[] = [];
    for (let i = 0; i < count; i++) {
      const neighbors: number[] = [];
      for (let c = 0; c < mol.getAllConnAtoms(i); c++) neighbors.push(mol.getConnAtom(i, c));
      atoms.push({
        el: mol.getAtomLabel(i),
        x: mol.getAtomX(i),
        y: mol.getAtomY(i),
        z: mol.getAtomZ(i),
        charge: mol.getAtomCharge(i),
        unpaired: unpairedElectrons(this.ocl, mol.getAtomRadical(i)),
        neighbors,
      });
    }
    return { atoms };
  }
}

/**
 * Whether a record carries real 3D coordinates.
 *
 * The molfile header's second line declares this in columns 21-22 ("2D"
 * or "3D"), and that declaration is believed first: a flat *z* is not
 * proof of a 2D drawing — water, benzene and every planar molecule lie
 * in a plane in 3D too, and re-embedding one would silently throw away
 * the conformer the file exists to carry. Only when the header says
 * nothing do the coordinates decide.
 */
export function declaredDimensionality(molfile: string): "2D" | "3D" | null {
  const code = (molfile.split("\n")[1] ?? "").slice(20, 22).trim().toUpperCase();
  return code === "2D" || code === "3D" ? code : null;
}

function isThreeD(
  molfile: string,
  mol: { getAllAtoms(): number; getAtomZ(i: number): number },
): boolean {
  const declared = declaredDimensionality(molfile);
  if (declared) return declared === "3D";
  const count = mol.getAllAtoms();
  for (let i = 0; i < count; i++) {
    if (mol.getAtomZ(i) !== 0) return true;
  }
  return false;
}

/** Radical state → unpaired electrons (doublet 1, triplet 2, else 0). */
function unpairedElectrons(ocl: OCLModule, state: number): number {
  if (state === ocl.Molecule.cAtomRadicalStateD) return 1;
  if (state === ocl.Molecule.cAtomRadicalStateT) return 2;
  return 0;
}
