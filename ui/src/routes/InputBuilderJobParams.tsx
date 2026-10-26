import {
  SCAN_ATOM_COUNT,
  ScanCoordId,
  type MECPSettings,
  type ScanSettings,
  type TDDFTSettings,
} from "../lib/inputBuilder/types";

const COORD_LABELS: Record<ScanCoordId, string> = {
  [ScanCoordId.Bond]: "Bond length (Å)",
  [ScanCoordId.Angle]: "Angle (°)",
  [ScanCoordId.Dihedral]: "Dihedral (°)",
};

/**
 * The per-job parameter groups: each job type declares which of these it
 * needs (jobs.v1.yaml), and only those render. Everything is typed —
 * nothing here is a keyword the user has to spell.
 */

/** `%geom Scan`: the driven coordinate of a relaxed scan. */
export function ScanFields({
  scan,
  atomCount,
  onChange,
}: {
  scan: ScanSettings;
  atomCount: number;
  onChange: (next: ScanSettings) => void;
}) {
  const wanted = SCAN_ATOM_COUNT[scan.coord];
  const setAtom = (i: number, value: number) => {
    const atoms = [...scan.atoms];
    atoms[i] = value;
    onChange({ ...scan, atoms });
  };
  return (
    <>
      <label className="ib-field">
        <span>Scan coordinate</span>
        <select
          value={scan.coord}
          onChange={(e) => {
            const coord = e.target.value as ScanCoordId;
            const count = SCAN_ATOM_COUNT[coord];
            const atoms = Array.from({ length: count }, (_, i) => scan.atoms[i] ?? i);
            onChange({ ...scan, coord, atoms });
          }}
        >
          {Object.values(ScanCoordId).map((c) => (
            <option key={c} value={c}>
              {COORD_LABELS[c]}
            </option>
          ))}
        </select>
        <span className="dim">
          Atom numbering is ORCA's: 0-based, in the order of the coordinate block
          {atomCount > 0 ? ` (0–${atomCount - 1})` : ""}.
        </span>
      </label>
      <label className="ib-field">
        <span>Atoms</span>
        <span className="ib-row">
          {Array.from({ length: wanted }, (_, i) => (
            <input
              key={i}
              type="number"
              min={0}
              aria-label={`Scan atom ${i + 1}`}
              value={scan.atoms[i] ?? 0}
              onChange={(e) => setAtom(i, Number(e.target.value))}
            />
          ))}
        </span>
      </label>
      <label className="ib-field">
        <span>From</span>
        <input
          type="number"
          step="any"
          value={scan.from}
          onChange={(e) => onChange({ ...scan, from: Number(e.target.value) })}
        />
      </label>
      <label className="ib-field">
        <span>To</span>
        <input
          type="number"
          step="any"
          value={scan.to}
          onChange={(e) => onChange({ ...scan, to: Number(e.target.value) })}
        />
      </label>
      <label className="ib-field">
        <span>Points</span>
        <input
          type="number"
          min={2}
          value={scan.steps}
          onChange={(e) => onChange({ ...scan, steps: Number(e.target.value) })}
        />
        <span className="dim">One full optimization per point — the cost is this number times an Opt.</span>
      </label>
    </>
  );
}

/** `%tddft`: how many excited states, and whether triplets come along. */
export function TDDFTFields({
  tddft,
  onChange,
}: {
  tddft: TDDFTSettings;
  onChange: (next: TDDFTSettings) => void;
}) {
  return (
    <>
      <label className="ib-field">
        <span>Excited states (NRoots)</span>
        <input
          type="number"
          min={1}
          value={tddft.nroots}
          onChange={(e) => onChange({ ...tddft, nroots: Number(e.target.value) })}
        />
        <span className="dim">Solve for this many roots; the spectrum can only show what was solved.</span>
      </label>
      <label className="ib-field">
        <span>Triplets</span>
        <span className="ib-row">
          <input
            type="checkbox"
            checked={tddft.triplets}
            onChange={(e) => onChange({ ...tddft, triplets: e.target.checked })}
          />
          <span className="dim">
            Also compute triplet states. They carry no oscillator strength — for absorption alone, leave off.
          </span>
        </span>
      </label>
    </>
  );
}

/** `%mecp`: the multiplicity of the second surface. */
export function MECPFields({
  mecp,
  mult1,
  onChange,
}: {
  mecp: MECPSettings;
  mult1: number;
  onChange: (next: MECPSettings) => void;
}) {
  return (
    <label className="ib-field">
      <span>Second state multiplicity</span>
      <input
        type="number"
        min={1}
        value={mecp.mult2}
        onChange={(e) => onChange({ ...mecp, mult2: Number(e.target.value) })}
      />
      <span className="dim">
        State 1 is the multiplicity above ({mult1}); this is state 2. The MECP tab plots both surfaces and
        their gap in that order.
      </span>
    </label>
  );
}
