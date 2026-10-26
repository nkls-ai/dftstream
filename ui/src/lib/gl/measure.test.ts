import { describe, expect, test } from "bun:test";
import { MEASURE_ATOMS, computeMeasurement, type PickedAtom } from "./measure";

function atom(index: number, elem: string, x: number, y: number, z: number): PickedAtom {
  return { index, elem, pos: { x, y, z } };
}

describe("MEASURE_ATOMS", () => {
  test("atom counts per mode", () => {
    expect(MEASURE_ATOMS.off).toBe(0);
    expect(MEASURE_ATOMS.distance).toBe(2);
    expect(MEASURE_ATOMS.angle).toBe(3);
    expect(MEASURE_ATOMS.dihedral).toBe(4);
  });
});

describe("computeMeasurement", () => {
  test("distance value and label formatting", () => {
    const { value, label } = computeMeasurement("distance", [
      atom(1, "H", 0, 0, 0),
      atom(2, "O", 0, 0, 1.5),
    ]);
    expect(value).toBeCloseTo(1.5, 10);
    expect(label).toBe("H1–O2: 1.500 Å");
  });

  test("right angle value and label formatting", () => {
    const { value, label } = computeMeasurement("angle", [
      atom(1, "H", 1, 0, 0),
      atom(2, "O", 0, 0, 0),
      atom(3, "H", 0, 1, 0),
    ]);
    expect(value).toBeCloseTo(90, 8);
    expect(label).toBe("∠H1–O2–H3: 90.0°");
  });

  test("trans dihedral is 180 degrees", () => {
    const { value, label } = computeMeasurement("dihedral", [
      atom(1, "C", 0, 1, 0),
      atom(2, "C", 0, 0, 0),
      atom(3, "C", 1, 0, 0),
      atom(4, "C", 1, -1, 0),
    ]);
    expect(Math.abs(value)).toBeCloseTo(180, 8);
    expect(label).toBe(`φ C1–C2–C3–C4: ${value.toFixed(1)}°`);
  });

  test("cis dihedral is 0 degrees", () => {
    const { value } = computeMeasurement("dihedral", [
      atom(1, "C", 0, 1, 0),
      atom(2, "C", 0, 0, 0),
      atom(3, "C", 1, 0, 0),
      atom(4, "C", 1, 1, 0),
    ]);
    expect(value).toBeCloseTo(0, 8);
  });

  test("off mode returns empty measurement", () => {
    const { value, label } = computeMeasurement("off", []);
    expect(value).toBe(0);
    expect(label).toBe("");
  });
});
