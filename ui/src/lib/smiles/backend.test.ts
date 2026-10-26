import { expect, test } from "bun:test";
import { declaredDimensionality, loadEmbedBackend } from "./backend";
import { firstSDFRecord, molfileTo3DWith, sdfRecordCount, smilesTo3DWith } from "./smiles";
import { minPairwiseDistance } from "./embed";
import { MIN_VALID_ATOM_DISTANCE, SF5_SF_DISTANCE } from "./types";

/**
 * End-to-end through the real chemistry toolkit. It is loaded once and
 * shared, so the whole file costs about a second.
 */
async function backend() {
  const b = await loadEmbedBackend();
  if ("kind" in b) throw new Error(`backend unavailable: ${b.message}`);
  return b;
}

test("ethanol embeds into a sane 3D geometry", async () => {
  const res = smilesTo3DWith(await backend(), "CCO");
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.molecule.atoms.length).toBe(9); // C2H6O, hydrogens added
  expect(res.molecule.charge).toBe(0);
  expect(res.molecule.multiplicity).toBe(1);
  expect(minPairwiseDistance(res.molecule.atoms)).toBeGreaterThan(MIN_VALID_ATOM_DISTANCE);
});

test("the seed makes the geometry reproducible", async () => {
  const b = await backend();
  const a = smilesTo3DWith(b, "OCC(=O)O");
  const c = smilesTo3DWith(b, "OCC(=O)O");
  expect(a.ok && c.ok).toBe(true);
  if (!a.ok || !c.ok) return;
  expect(a.molecule.atoms).toEqual(c.molecule.atoms);
});

test("charge and radicals are read from the SMILES", async () => {
  const b = await backend();
  const acetate = smilesTo3DWith(b, "CC(=O)[O-]");
  expect(acetate.ok).toBe(true);
  if (acetate.ok) expect(acetate.molecule.charge).toBe(-1);

  const ethyl = smilesTo3DWith(b, "C[CH2]");
  expect(ethyl.ok).toBe(true);
  if (ethyl.ok) expect(ethyl.molecule.multiplicity).toBe(2);
});

test("an SF5 aryl comes out octahedral, with the force field skipped", async () => {
  const res = smilesTo3DWith(await backend(), "FS(F)(F)(F)(F)c1ccccc1");
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  const atoms = res.molecule.atoms;
  const sIdx = atoms.findIndex((a) => a.el === "S");
  expect(sIdx).toBeGreaterThanOrEqual(0);
  const s = atoms[sIdx]!;
  const sfDistances = atoms
    .filter((a) => a.el === "F")
    .map((f) => Math.hypot(f.x - s.x, f.y - s.y, f.z - s.z));
  expect(sfDistances.length).toBe(5);
  for (const d of sfDistances) expect(d).toBeCloseTo(SF5_SF_DISTANCE, 6);
  expect(res.molecule.notes.some((n) => n.includes("octahedron"))).toBe(true);
  expect(res.molecule.notes.some((n) => n.toLowerCase().includes("force field"))).toBe(true);
  expect(minPairwiseDistance(atoms)).toBeGreaterThan(MIN_VALID_ATOM_DISTANCE);
});

test("nonsense input is refused with a typed error", async () => {
  const res = smilesTo3DWith(await backend(), "this is not a smiles");
  expect(res.ok).toBe(false);
});

// --- molfile / SDF ----------------------------------------------------------

/** A 3D molfile of water: planar (as water is) but declared 3D in the
 *  header's dimensional code, columns 21-22 of line 2. */
const WATER_3D = `water
  DFTStream         3D

  3  2  0  0  0  0  0  0  0  0999 V2000
    0.0000    0.0000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0
    0.9580    0.0000    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
   -0.2400    0.9270    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
  1  2  1  0  0  0  0
  1  3  1  0  0  0  0
M  END
`;

/** A flat (2D) molfile, as a sketcher would export it: every z is 0. */
const ETHANOL_2D = `ethanol
  DFTStream         2D

  3  2  0  0  0  0  0  0  0  0999 V2000
    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    1.5000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    2.2500    1.3000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0
  1  2  1  0  0  0  0
  2  3  1  0  0  0  0
M  END
`;

test("a 3D molfile keeps its own conformer", async () => {
  const res = molfileTo3DWith(await backend(), WATER_3D, "water.mol");
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.molecule.atoms.map((a) => a.el)).toEqual(["O", "H", "H"]);
  expect(res.molecule.atoms[1]?.x).toBeCloseTo(0.958, 6);
  expect(res.molecule.notes.some((n) => n.includes("own 3D coordinates"))).toBe(true);
});

test("a flat 2D molfile is embedded and gains its hydrogens", async () => {
  const res = molfileTo3DWith(await backend(), ETHANOL_2D, "ethanol.mol");
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  // C2H6O: the three heavy atoms plus the hydrogens the valence model adds.
  expect(res.molecule.atoms.length).toBe(9);
  expect(res.molecule.atoms.some((a) => a.z !== 0)).toBe(true);
  expect(minPairwiseDistance(res.molecule.atoms)).toBeGreaterThan(MIN_VALID_ATOM_DISTANCE);
});

test("an SDF library yields its first record, not all of them fused", async () => {
  const sdf = `${WATER_3D}$$$$\n${ETHANOL_2D}$$$$\n`;
  expect(sdfRecordCount(sdf)).toBe(2);
  expect(firstSDFRecord(sdf).trimEnd()).toBe(WATER_3D.trimEnd());
  const res = molfileTo3DWith(await backend(), sdf, "library.sdf");
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.molecule.atoms.length).toBe(3);
});

test("the header's dimensional code is what decides, not a flat z", () => {
  // Water IS planar in 3D; deciding from the coordinates alone would
  // re-embed it and throw away the conformer the file exists to carry.
  expect(declaredDimensionality(WATER_3D)).toBe("3D");
  expect(declaredDimensionality(ETHANOL_2D)).toBe("2D");
  expect(declaredDimensionality("name\n  someprogram\n\n")).toBeNull();
});

test("an empty or unreadable molfile is a typed error, never an empty molecule", async () => {
  const b = await backend();
  expect(molfileTo3DWith(b, "   ", "empty.mol").ok).toBe(false);
  expect(molfileTo3DWith(b, "this is not a molfile at all\n", "bad.mol").ok).toBe(false);
});
