import { expect, test } from "bun:test";
import { applySF5Geometry, findSF5Groups } from "./sf5";
import { SF5_SF_DISTANCE, SF5_SUBSTITUENT_DISTANCE, type GraphAtom, type MolecularGraph } from "./types";

function atom(el: string, x = 0, y = 0, z = 0, neighbors: number[] = []): GraphAtom {
  return { el, x, y, z, charge: 0, unpaired: 0, neighbors };
}

/** CH3-SF5 with a deliberately squashed SF5, the way an embedder that
 *  has no parameters for hypervalent sulfur leaves it. */
function squashedSF5(): MolecularGraph {
  const atoms: GraphAtom[] = [
    atom("S", 0, 0, 0, [1, 2, 3, 4, 5, 6]),
    atom("F", 0.4, 0, 0, [0]),
    atom("F", -0.4, 0, 0, [0]),
    atom("F", 0, 0.4, 0, [0]),
    atom("F", 0, -0.4, 0, [0]),
    atom("F", 0, 0, -0.4, [0]),
    atom("C", 0, 0, 1.2, [0, 7]),
    atom("H", 0, 0, 2.3, [6]),
  ];
  return { atoms };
}

const dist = (a: GraphAtom, b: GraphAtom) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

test("an SF5 group is recognized by its five fluorines", () => {
  const groups = findSF5Groups(squashedSF5());
  expect(groups.length).toBe(1);
  expect(groups[0]?.sulfur).toBe(0);
  expect(groups[0]?.fluorines).toEqual([1, 2, 3, 4, 5]);
  expect(groups[0]?.substituent).toBe(6);
});

test("SF6 and SF4 are not SF5", () => {
  const sf6: MolecularGraph = {
    atoms: [atom("S", 0, 0, 0, [1, 2, 3, 4, 5, 6]), ...Array.from({ length: 6 }, () => atom("F", 1, 0, 0, [0]))],
  };
  expect(findSF5Groups(sf6)).toEqual([]);
  const sf4: MolecularGraph = {
    atoms: [atom("S", 0, 0, 0, [1, 2, 3, 4]), ...Array.from({ length: 4 }, () => atom("F", 1, 0, 0, [0]))],
  };
  expect(findSF5Groups(sf4)).toEqual([]);
});

test("the repair rebuilds an ideal octahedron at 1.58 Å", () => {
  const { atoms, repaired } = applySF5Geometry(squashedSF5());
  expect(repaired).toBe(1);
  const s = atoms[0]!;
  for (const f of [1, 2, 3, 4, 5]) {
    expect(dist(s, atoms[f]!)).toBeCloseTo(SF5_SF_DISTANCE, 6);
  }
  // Four equatorial fluorines are mutually perpendicular around S; the
  // fifth sits trans to the substituent.
  const axial = atoms[5]!;
  expect(axial.z).toBeCloseTo(-SF5_SF_DISTANCE, 6);
  for (const f of [1, 2, 3, 4]) expect(atoms[f]!.z).toBeCloseTo(0, 6);
});

test("the substituent moves to 1.85 Å and drags its fragment along rigidly", () => {
  const before = squashedSF5();
  const { atoms } = applySF5Geometry(before);
  expect(dist(atoms[0]!, atoms[6]!)).toBeCloseTo(SF5_SUBSTITUENT_DISTANCE, 6);
  // The C–H bond that hangs off the substituent keeps its length: the
  // fragment is translated, never stretched.
  expect(dist(atoms[6]!, atoms[7]!)).toBeCloseTo(dist(before.atoms[6]!, before.atoms[7]!), 10);
});

test("a molecule with no SF5 is returned untouched", () => {
  const graph: MolecularGraph = { atoms: [atom("C", 0, 0, 0, [1]), atom("O", 1.2, 0, 0, [0])] };
  const { atoms, repaired } = applySF5Geometry(graph);
  expect(repaired).toBe(0);
  expect(atoms).toBe(graph.atoms);
});

test("a bare SF5 anion is repaired without a substituent", () => {
  const graph: MolecularGraph = {
    atoms: [
      { ...atom("S", 0, 0, 0, [1, 2, 3, 4, 5]), charge: -1 },
      atom("F", 0.3, 0, 0, [0]),
      atom("F", -0.3, 0, 0, [0]),
      atom("F", 0, 0.3, 0, [0]),
      atom("F", 0, -0.3, 0, [0]),
      atom("F", 0, 0, -0.3, [0]),
    ],
  };
  const { atoms, repaired } = applySF5Geometry(graph);
  expect(repaired).toBe(1);
  for (const f of [1, 2, 3, 4, 5]) expect(dist(atoms[0]!, atoms[f]!)).toBeCloseTo(SF5_SF_DISTANCE, 6);
});
