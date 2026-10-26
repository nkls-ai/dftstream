import { useMemo, useRef, useState, type ReactNode } from "react";
import { molecularFormula, parseStructureText } from "../lib/inputBuilder/xyz";
import {
  formatForFileName,
  loadStructureFile,
  StructureFormat,
  STRUCTURE_FILE_ACCEPT,
} from "../lib/inputBuilder/structureFiles";
import { StructureSource, type Structure } from "../lib/inputBuilder/types";
import { MIN_VALID_ATOM_DISTANCE } from "../lib/smiles/types";
import { minPairwiseDistance } from "../lib/smiles/embed";

/** How the user is entering this structure. */
enum StructureMode {
  Paste = "paste",
  File = "file",
  Smiles = "smiles",
  PreviousRun = "run",
}

const MODE_LABELS: Record<StructureMode, string> = {
  [StructureMode.Paste]: "Paste XYZ",
  [StructureMode.File]: "Upload file",
  [StructureMode.Smiles]: "SMILES",
  [StructureMode.PreviousRun]: "Previous run",
};

export interface StructureAdopted {
  structure: Structure;
  /** Charge/multiplicity the source declared, when it did. */
  charge?: number;
  multiplicity?: number;
  notes?: string[];
}

export function InputBuilderStructure({
  title,
  hint,
  structure,
  onAdopt,
  onClear,
  runPicker,
}: {
  title: string;
  hint?: string;
  structure: Structure | null;
  onAdopt: (adopted: StructureAdopted) => void;
  onClear: () => void;
  /** The "start from a previous run" panel; its tab is hidden without one
   *  (the page mounts it only where a DataSource is available). */
  runPicker?: ReactNode;
}) {
  const [mode, setMode] = useState<StructureMode>(StructureMode.Paste);
  const [pasted, setPasted] = useState("");
  const [smiles, setSmiles] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement | null>(null);

  function adoptText(text: string, source: StructureSource, label: string) {
    const parsed = parseStructureText(text, source, label);
    setErrors(parsed.errors);
    setNotes([]);
    if (!parsed.structure) return;
    onAdopt({
      structure: parsed.structure,
      charge: parsed.charge ?? undefined,
      multiplicity: parsed.multiplicity ?? undefined,
    });
  }

  async function loadFile(file: File) {
    setBusy(true);
    setErrors([]);
    setNotes([]);
    try {
      const text = await file.text();
      // An unknown extension is read as .xyz rather than refused: the
      // format is guessable from the content, and refusing a renamed
      // file helps nobody.
      const format = formatForFileName(file.name) ?? StructureFormat.XYZ;
      if (format === StructureFormat.Molfile) {
        await loadMolfile(text, file.name);
        return;
      }
      const parsed = loadStructureFile(text, file.name, format);
      setErrors(parsed.errors);
      setNotes(parsed.notes);
      if (!parsed.structure) return;
      onAdopt({
        structure: parsed.structure,
        charge: parsed.charge ?? undefined,
        multiplicity: parsed.multiplicity ?? undefined,
        notes: parsed.notes,
      });
    } catch (err: unknown) {
      setErrors([`could not read ${file.name}: ${err instanceof Error ? err.message : String(err)}`]);
    } finally {
      setBusy(false);
    }
  }

  /** Molfiles/SDF go through the chemistry toolkit: only it knows the
   *  valence model that fills in hydrogens, charge and spin. */
  async function loadMolfile(text: string, fileName: string) {
    // Loaded on demand, same as the SMILES path — several megabytes.
    const { molfileTo3D, sdfRecordCount } = await import("../lib/smiles/smiles");
    const result = await molfileTo3D(text, fileName);
    if (!result.ok) {
      setErrors([result.error.message]);
      return;
    }
    const mol = result.molecule;
    const extra = sdfRecordCount(text) > 1 ? ["the file holds several records — the first one was read"] : [];
    setNotes([...extra, ...mol.notes]);
    onAdopt({
      structure: { atoms: mol.atoms, source: StructureSource.File, label: fileName },
      charge: mol.charge,
      multiplicity: mol.multiplicity,
      notes: mol.notes,
    });
  }

  async function embedSmiles() {
    const query = smiles.trim();
    if (!query) return;
    setBusy(true);
    setErrors([]);
    setNotes([]);
    try {
      // Loaded on demand: the chemistry toolkit is several megabytes and
      // most inputs never need it.
      const { smilesTo3D } = await import("../lib/smiles/smiles");
      const result = await smilesTo3D(query);
      if (!result.ok) {
        setErrors([result.error.message]);
        return;
      }
      const mol = result.molecule;
      setNotes(mol.notes);
      onAdopt({
        structure: { atoms: mol.atoms, source: StructureSource.Smiles, label: mol.smiles },
        charge: mol.charge,
        multiplicity: mol.multiplicity,
        notes: mol.notes,
      });
    } catch (err: unknown) {
      setErrors([`SMILES conversion failed: ${err instanceof Error ? err.message : String(err)}`]);
    } finally {
      setBusy(false);
    }
  }

  // minPairwiseDistance is O(n²). Un-memoized this ran on every render, and
  // this component re-renders on every keystroke in the SMILES box and the
  // paste textarea: with a 3000-atom structure adopted, each character typed
  // cost ~4.5M distance evaluations on the main thread and the field visibly
  // stalled. The geometry only changes when `structure` does.
  const contact = useMemo(
    () => (structure ? minPairwiseDistance(structure.atoms) : Infinity),
    [structure],
  );

  return (
    <div className="ib-structure">
      <div className="ib-structure-head">
        <strong>{title}</strong>
        {hint && <span className="dim">{hint}</span>}
      </div>

      <div className="ib-tabs" role="tablist" aria-label={`${title} input mode`}>
        {Object.values(StructureMode)
          .filter((m) => m !== StructureMode.PreviousRun || runPicker)
          .map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            className={"ib-tab" + (mode === m ? " active" : "")}
            onClick={() => setMode(m)}
          >
            {MODE_LABELS[m]}
          </button>
        ))}
      </div>

      {mode === StructureMode.Paste && (
        <div className="ib-field">
          <textarea
            className="mono ib-paste"
            rows={6}
            spellCheck={false}
            placeholder={"3\nwater\nO  0.000  0.000  0.000\nH  0.958  0.000  0.000\nH -0.240  0.927  0.000"}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            aria-label={`${title} coordinates`}
          />
          <button
            type="button"
            className="button"
            disabled={!pasted.trim()}
            onClick={() => adoptText(pasted, StructureSource.Pasted, "")}
          >
            Use these coordinates
          </button>
          <span className="dim">
            An .xyz file, a bare <code>El x y z</code> block, or an ORCA <code>* xyz … *</code> block.
          </span>
        </div>
      )}

      {mode === StructureMode.File && (
        <div className="ib-field">
          <input
            ref={fileRef}
            type="file"
            accept={STRUCTURE_FILE_ACCEPT}
            aria-label={`${title} file`}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void loadFile(file);
              event.currentTarget.value = "";
            }}
          />
          <span className="dim">
            .xyz, .mol/.sdf and .pdb. Read in your browser — nothing is uploaded.
            {busy ? " Reading…" : ""}
          </span>
        </div>
      )}

      {mode === StructureMode.PreviousRun && runPicker}

      {mode === StructureMode.Smiles && (
        <div className="ib-field">
          <div className="ib-row">
            <input
              type="text"
              className="mono"
              placeholder="CC(=O)Oc1ccccc1C(=O)O"
              value={smiles}
              spellCheck={false}
              aria-label={`${title} SMILES`}
              onChange={(e) => setSmiles(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void embedSmiles();
              }}
            />
            <button type="button" className="button" disabled={busy || !smiles.trim()} onClick={() => void embedSmiles()}>
              {busy ? "Building…" : "Build 3D"}
            </button>
          </div>
          <span className="dim">
            Charge and spin are read from the SMILES. The 3D toolkit loads on first use.
          </span>
        </div>
      )}

      {errors.length > 0 && (
        <ul className="ib-findings">
          {errors.map((e, i) => (
            <li key={i} className="ib-finding error">
              {e}
            </li>
          ))}
        </ul>
      )}
      {notes.length > 0 && (
        <ul className="ib-findings">
          {notes.map((n, i) => (
            <li key={i} className="ib-finding info">
              {n}
            </li>
          ))}
        </ul>
      )}

      {structure && (
        <div className="ib-structure-summary">
          <span className="ib-formula">{molecularFormula(structure.atoms)}</span>
          <span className="dim">
            {structure.atoms.length} atoms · {structure.source}
            {structure.label ? ` · ${structure.label}` : ""}
          </span>
          {contact < MIN_VALID_ATOM_DISTANCE && (
            <span className="ib-finding error">
              closest contact {contact.toFixed(2)} Å — atoms are overlapping
            </span>
          )}
          <button type="button" className="dl-btn" onClick={onClear}>
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
