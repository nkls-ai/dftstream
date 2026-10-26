import { describe, test, expect } from "bun:test";
import { atomDistance, atomAngle, atomDihedral, midpoint, type Vec3 } from "./geometry";

describe("atomDistance", () => {
  test("unit distance along x", () => {
    expect(atomDistance({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })).toBeCloseTo(1.0);
  });

  test("3D distance", () => {
    expect(atomDistance({ x: 1, y: 2, z: 3 }, { x: 4, y: 6, z: 3 })).toBeCloseTo(5.0);
  });

  test("zero distance", () => {
    expect(atomDistance({ x: 5, y: 5, z: 5 }, { x: 5, y: 5, z: 5 })).toBeCloseTo(0);
  });

  test("water O-H bond ~0.96 Å", () => {
    const O: Vec3 = { x: 0, y: 0, z: 0 };
    const H: Vec3 = { x: 0.757, y: 0.587, z: 0 };
    expect(atomDistance(O, H)).toBeCloseTo(0.958, 2);
  });
});

describe("atomAngle", () => {
  test("right angle", () => {
    expect(atomAngle(
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
    )).toBeCloseTo(90);
  });

  test("linear = 180°", () => {
    expect(atomAngle(
      { x: -1, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
    )).toBeCloseTo(180);
  });

  test("equilateral triangle = 60°", () => {
    expect(atomAngle(
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0.5, y: Math.sqrt(3) / 2, z: 0 },
    )).toBeCloseTo(60);
  });

  test("water H-O-H ~104.5°", () => {
    const H1: Vec3 = { x: 0.757, y: 0.587, z: 0 };
    const O: Vec3 = { x: 0, y: 0, z: 0 };
    const H2: Vec3 = { x: -0.757, y: 0.587, z: 0 };
    expect(atomAngle(H1, O, H2)).toBeCloseTo(104.5, 0);
  });
});

describe("atomDihedral", () => {
  test("eclipsed (cis) = 0°", () => {
    const a: Vec3 = { x: 1, y: 1, z: 0 };
    const b: Vec3 = { x: 0, y: 1, z: 0 };
    const c: Vec3 = { x: 0, y: 0, z: 0 };
    const d: Vec3 = { x: 1, y: 0, z: 0 };
    expect(Math.abs(atomDihedral(a, b, c, d))).toBeCloseTo(0, 0);
  });

  test("anti (trans) = ±180°", () => {
    const a: Vec3 = { x: 1, y: 1, z: 0 };
    const b: Vec3 = { x: 0, y: 1, z: 0 };
    const c: Vec3 = { x: 0, y: 0, z: 0 };
    const d: Vec3 = { x: -1, y: 0, z: 0 };
    expect(Math.abs(atomDihedral(a, b, c, d))).toBeCloseTo(180, 0);
  });

  test("gauche ~90°", () => {
    const a: Vec3 = { x: 1, y: 1, z: 0 };
    const b: Vec3 = { x: 0, y: 1, z: 0 };
    const c: Vec3 = { x: 0, y: 0, z: 0 };
    const d: Vec3 = { x: 0, y: 0, z: 1 };
    expect(Math.abs(atomDihedral(a, b, c, d))).toBeCloseTo(90, 0);
  });
});

describe("midpoint", () => {
  test("origin pair", () => {
    const m = midpoint({ x: 0, y: 0, z: 0 }, { x: 2, y: 4, z: 6 });
    expect(m.x).toBeCloseTo(1);
    expect(m.y).toBeCloseTo(2);
    expect(m.z).toBeCloseTo(3);
  });
});
