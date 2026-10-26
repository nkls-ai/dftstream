import { expect, test } from "bun:test";
import { minPairwiseDistance, molecularFormula, parseStructureText } from "./xyz";
import { StructureSource } from "./types";
import { recommendedMaxCoreMB } from "./resources";

test("a standard .xyz file parses", () => {
  const res = parseStructureText("3\nwater\nO 0.0 0.0 0.0\nH 0.96 0.0 0.0\nH -0.24 0.93 0.0\n", StructureSource.File, "water.xyz");
  expect(res.errors).toEqual([]);
  expect(res.structure?.atoms.length).toBe(3);
  expect(res.structure?.atoms[1]).toEqual({ el: "H", x: 0.96, y: 0, z: 0 });
  expect(res.structure?.label).toBe("water.xyz");
});

test("a bare coordinate block pasted from an output parses", () => {
  const res = parseStructureText("  C     0.000000    0.000000    0.000000\n  N     0.000000    0.000000    1.160000\n", StructureSource.Pasted);
  expect(res.errors).toEqual([]);
  expect(res.structure?.atoms.map((a) => a.el)).toEqual(["C", "N"]);
});

test("an ORCA coordinate block keeps its charge and multiplicity", () => {
  const res = parseStructureText("* xyz -1 2\nO 0 0 0\nH 0.96 0 0\n*\n", StructureSource.Pasted);
  expect(res.errors).toEqual([]);
  expect(res.charge).toBe(-1);
  expect(res.multiplicity).toBe(2);
  expect(res.structure?.atoms.length).toBe(2);
});

test("element casing is normalized", () => {
  const res = parseStructureText("2\n\nfe 0 0 0\nCL 1 0 0\n", StructureSource.Pasted);
  expect(res.structure?.atoms.map((a) => a.el)).toEqual(["Fe", "Cl"]);
});

test("scientific notation and negative coordinates parse", () => {
  const res = parseStructureText("1\n\nH -1.5e-2 0.0 3.4E1\n", StructureSource.Pasted);
  expect(res.structure?.atoms[0]).toEqual({ el: "H", x: -0.015, y: 0, z: 34 });
});

test("an unreadable row is reported, never skipped silently", () => {
  const res = parseStructureText("2\nbad\nO 0 0 0\nH 0.96 zero 0\n", StructureSource.Pasted);
  expect(res.errors.some((e) => e.includes("line 4"))).toBe(true);
  expect(res.errors.some((e) => e.includes("header says 2 atoms, found 1"))).toBe(true);
});

test("text with no atoms yields no structure", () => {
  const res = parseStructureText("hello there\n", StructureSource.Pasted);
  expect(res.structure).toBeNull();
  expect(res.errors.some((e) => e.includes("no atoms found"))).toBe(true);
});

test("minPairwiseDistance finds the closest contact", () => {
  expect(minPairwiseDistance([])).toBe(Infinity);
  expect(minPairwiseDistance([{ el: "H", x: 0, y: 0, z: 0 }])).toBe(Infinity);
  expect(
    minPairwiseDistance([
      { el: "H", x: 0, y: 0, z: 0 },
      { el: "H", x: 0, y: 0, z: 0.74 },
      { el: "O", x: 0, y: 0, z: 5 },
    ]),
  ).toBeCloseTo(0.74, 10);
});

test("molecular formula uses Hill order", () => {
  expect(
    molecularFormula([
      { el: "O", x: 0, y: 0, z: 0 },
      { el: "H", x: 0, y: 0, z: 0 },
      { el: "H", x: 0, y: 0, z: 0 },
    ]),
  ).toBe("H2O");
  expect(
    molecularFormula([
      { el: "C", x: 0, y: 0, z: 0 },
      { el: "H", x: 0, y: 0, z: 0 },
      { el: "H", x: 0, y: 0, z: 0 },
      { el: "H", x: 0, y: 0, z: 0 },
      { el: "H", x: 0, y: 0, z: 0 },
    ]),
  ).toBe("CH4");
});

test("the 75%-of-RAM rule matches the wrapper and the group's tooling", () => {
  expect(recommendedMaxCoreMB(64 * 1024, 8)).toBe(6000);
  expect(recommendedMaxCoreMB(16 * 1024, 4)).toBe(3000);
  expect(recommendedMaxCoreMB(8 * 1024, 16)).toBe(0); // below 1 GB/core → omit %maxcore
  expect(recommendedMaxCoreMB(0, 8)).toBe(0);
  expect(recommendedMaxCoreMB(64 * 1024, 0)).toBe(0);
});
