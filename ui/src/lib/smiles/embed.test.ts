import { expect, test } from "bun:test";
import {
  chooseCleanup,
  finishMolecule,
  hasSF5,
  minPairwiseDistance,
  multiplicity,
  totalCharge,
  validateGeometry,
} from "./embed";
import { smilesTo3DWith } from "./smiles";
import { CleanupPolicy, SmilesErrorKind, type GraphAtom, type MolecularGraph } from "./types";
import type { EmbedBackend } from "./backend";

function atom(el: string, x = 0, y = 0, z = 0, over: Partial<GraphAtom> = {}): GraphAtom {
  return { el, x, y, z, charge: 0, unpaired: 0, neighbors: [], ...over };
}

const ethanolish: MolecularGraph = {
  atoms: [atom("C", 0, 0, 0, { neighbors: [1] }), atom("O", 1.43, 0, 0, { neighbors: [0] })],
};

test("MMFF is used only when the molecule has no SF5", () => {
  // UFF is not an option anywhere in this module — it collapses SF5.
  expect(chooseCleanup(false)).toBe(CleanupPolicy.ForceField);
  expect(chooseCleanup(true)).toBe(CleanupPolicy.None);
});

test("charge and multiplicity come from the molecule, not a default", () => {
  const acetate: MolecularGraph = { atoms: [atom("O", 0, 0, 0, { charge: -1 }), atom("C", 1.3, 0, 0)] };
  expect(totalCharge(acetate)).toBe(-1);
  expect(multiplicity(acetate)).toBe(1);

  const radical: MolecularGraph = { atoms: [atom("C", 0, 0, 0, { unpaired: 1 })] };
  expect(multiplicity(radical)).toBe(2);

  const triplet: MolecularGraph = { atoms: [atom("O", 0, 0, 0, { unpaired: 1 }), atom("O", 1.2, 0, 0, { unpaired: 1 })] };
  expect(multiplicity(triplet)).toBe(3);
});

test("overlapping atoms are rejected, not shipped", () => {
  expect(minPairwiseDistance(ethanolish.atoms)).toBeCloseTo(1.43, 6);
  expect(validateGeometry(ethanolish.atoms, "CO")).toBeNull();

  const collapsed = [
    { x: 0, y: 0, z: 0 },
    { x: 0.5, y: 0, z: 0 },
  ];
  const err = validateGeometry(collapsed, "FS(F)(F)(F)F");
  expect(err?.kind).toBe(SmilesErrorKind.Overlap);
  expect(err?.message).toContain("0.500 Å < 0.7 Å");
});

test("finishMolecule repairs SF5 and says so", () => {
  const graph: MolecularGraph = {
    atoms: [
      atom("S", 0, 0, 0, { neighbors: [1, 2, 3, 4, 5, 6] }),
      atom("F", 0.5, 0, 0, { neighbors: [0] }),
      atom("F", -0.5, 0, 0, { neighbors: [0] }),
      atom("F", 0, 0.5, 0, { neighbors: [0] }),
      atom("F", 0, -0.5, 0, { neighbors: [0] }),
      atom("F", 0, 0, -0.5, { neighbors: [0] }),
      atom("C", 0, 0, 1.5, { neighbors: [0] }),
    ],
  };
  const res = finishMolecule(graph, { smiles: "CS(F)(F)(F)(F)F", cleanupApplied: CleanupPolicy.None });
  expect("molecule" in res).toBe(true);
  if (!("molecule" in res)) return;
  expect(res.molecule.notes.some((n) => n.includes("octahedron"))).toBe(true);
  expect(hasSF5(graph)).toBe(true);
});

test("a geometry that stays collapsed is an error, never a silent pass", () => {
  const stacked: MolecularGraph = { atoms: [atom("C"), atom("C", 0.1)] };
  const res = finishMolecule(stacked, { smiles: "CC", cleanupApplied: CleanupPolicy.ForceField });
  expect("error" in res).toBe(true);
  if ("error" in res) expect(res.error.kind).toBe(SmilesErrorKind.Overlap);
});

test("the orchestrator surfaces backend errors instead of throwing", () => {
  const failing: EmbedBackend = {
    embed: () => ({ error: { kind: SmilesErrorKind.Parse, message: "bad SMILES" } }),
    embedMolfile: () => ({ error: { kind: SmilesErrorKind.Parse, message: "bad molfile" } }),
  };
  const res = smilesTo3DWith(failing, "not-a-smiles");
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error.kind).toBe(SmilesErrorKind.Parse);
});

test("an empty SMILES never reaches the backend", () => {
  const exploding: EmbedBackend = {
    embed: () => {
      throw new Error("must not be called");
    },
    embedMolfile: () => {
      throw new Error("must not be called");
    },
  };
  const res = smilesTo3DWith(exploding, "   ");
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error.message).toContain("no SMILES");
});

test("a successful embed carries charge, multiplicity and the SMILES through", () => {
  const backend: EmbedBackend = {
    embed: () => ({
      graph: {
        atoms: [
          atom("O", 0, 0, 0, { charge: -1, neighbors: [1] }),
          atom("C", 1.3, 0, 0, { unpaired: 1, neighbors: [0] }),
        ],
      },
      cleanup: CleanupPolicy.ForceField,
    }),
    embedMolfile: () => {
      throw new Error("must not be called");
    },
    };
  const res = smilesTo3DWith(backend, " [O-][CH2] ");
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.molecule.charge).toBe(-1);
  expect(res.molecule.multiplicity).toBe(2);
  expect(res.molecule.smiles).toBe("[O-][CH2]");
  expect(res.molecule.atoms.length).toBe(2);
});
