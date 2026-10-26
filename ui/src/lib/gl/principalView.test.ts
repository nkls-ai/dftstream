import { describe, expect, test } from "bun:test";
import { principalViewQuaternion, rotateByQuaternion, type Point3 } from "./principalView";

function spread(points: Point3[], axis: 0 | 1 | 2): number {
  const vals = points.map((p) => p[axis]);
  return Math.max(...vals) - Math.min(...vals);
}

describe("principalViewQuaternion", () => {
  test("a molecule along z (HCN) is turned side-on, along screen x", () => {
    const hcn: Point3[] = [
      [0, 0, -1.06],
      [0, 0, 0],
      [0, 0, 1.15],
    ];
    const q = principalViewQuaternion(hcn);
    const rotated = hcn.map((p) => rotateByQuaternion(q, p));
    expect(spread(rotated, 0)).toBeCloseTo(2.21, 5);
    expect(spread(rotated, 2)).toBeCloseTo(0, 5);
  });

  test("a planar molecule faces the viewer", () => {
    // Water in the yz plane: smallest extent (x) must end up along z.
    const water: Point3[] = [
      [0, 0, 0],
      [0, 0.76, 0.59],
      [0, -0.76, 0.59],
    ];
    const rotated = water.map((p) => rotateByQuaternion(principalViewQuaternion(water), p));
    expect(spread(rotated, 2)).toBeCloseTo(0, 5);
    expect(spread(rotated, 0)).toBeCloseTo(1.52, 5);
  });

  test("result is a unit quaternion; trivial input is identity", () => {
    const q = principalViewQuaternion([
      [1, 2, 3],
      [-2, 0.5, 1],
      [0.3, -1, 2],
      [2, 2, -1],
    ]);
    expect(Math.hypot(...q)).toBeCloseTo(1, 9);
    expect(principalViewQuaternion([[1, 1, 1]])).toEqual([0, 0, 0, 1]);
  });
});
