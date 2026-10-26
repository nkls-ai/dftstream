import { describe, expect, test } from "bun:test";
import {
  buildSurfaceScene,
  computeZExtent,
  createProjector,
  findClosestProjected,
  pickTicks,
  surfaceColorForZ,
  type Project,
} from "./surfaceProjection";

describe("computeZExtent", () => {
  test("finds min/max ignoring null holes", () => {
    const { zMin, zMax, zRange } = computeZExtent([[1, 2], [null, 3]]);
    expect(zMin).toBe(1);
    expect(zMax).toBe(3);
    expect(zRange).toBe(2);
  });

  test("all-null grid collapses to zero with floored range", () => {
    const { zMin, zMax, zRange } = computeZExtent([[null, null]]);
    expect(zMin).toBe(0);
    expect(zMax).toBe(0);
    expect(zRange).toBe(1e-8);
  });

  test("empty grid collapses to zero", () => {
    const { zMin, zMax } = computeZExtent([]);
    expect(zMin).toBe(0);
    expect(zMax).toBe(0);
  });
});

describe("surfaceColorForZ", () => {
  test("endpoints and midpoint of the gradient", () => {
    expect(surfaceColorForZ(0, 0, 1)).toBe("rgb(94, 234, 212)");
    expect(surfaceColorForZ(0.5, 0, 1)).toBe("rgb(251, 191, 36)");
    expect(surfaceColorForZ(1, 0, 1)).toBe("rgb(248, 113, 113)");
  });

  test("clamps outside the range", () => {
    expect(surfaceColorForZ(-10, 0, 1)).toBe(surfaceColorForZ(0, 0, 1));
    expect(surfaceColorForZ(10, 0, 1)).toBe(surfaceColorForZ(1, 0, 1));
  });
});

describe("createProjector", () => {
  const params = {
    xMin: 0, xMax: 1, yMin: 0, yMax: 1, zMin: 0, zRange: 1,
    rxDeg: 0, ryDeg: 0, width: 200, height: 100,
  };

  test("center of the data box maps to canvas center at zero rotation", () => {
    const project = createProjector(params);
    const [sx, sy, depth] = project(0.5, 0.5, 0.5);
    expect(sx).toBeCloseTo(100, 10);
    expect(sy).toBeCloseTo(50, 10);
    expect(depth).toBeCloseTo(0, 10);
  });

  test("x maps to horizontal screen offset at zero rotation", () => {
    const project = createProjector(params);
    const [sx, sy] = project(1, 0.5, 0.5);
    // nx = 1, scale = w * 0.28, factor = 1 at depth 0
    expect(sx).toBeCloseTo(100 + 200 * 0.28, 10);
    expect(sy).toBeCloseTo(50, 10);
  });

  test("higher z comes toward the camera (negative view depth)", () => {
    const project = createProjector(params);
    const [, , depth] = project(0.5, 0.5, 1);
    expect(depth).toBeCloseTo(-1, 10);
  });

  test("90 degree y-rotation swaps x into depth", () => {
    const project = createProjector({ ...params, ryDeg: 90 });
    const [, , depth] = project(1, 0.5, 0.5);
    expect(depth).toBeCloseTo(0, 10);
    const [sx] = project(1, 0.5, 0.5);
    expect(sx).toBeCloseTo(100, 10);
  });
});

describe("buildSurfaceScene", () => {
  // Identity-ish projector: screen = data, depth = z.
  const flatProject: Project = (px, py, pz) => [px, py, pz];
  const color = () => "rgb(0, 0, 0)";

  test("full 2x2 grid yields 1 quad and all projected points", () => {
    const { quads, projected } = buildSurfaceScene(
      [0, 1], [0, 1],
      [[0, 1], [2, 3]],
      [[0, 1], [2, 3]],
      flatProject, color,
    );
    expect(quads).toHaveLength(1);
    expect(projected).toHaveLength(4);
    expect(quads[0]!.pts).toHaveLength(4);
    // Quad depth is the mean of its corner depths (z values here).
    expect(quads[0]!.z).toBeCloseTo(1.5, 10);
  });

  test("a null corner drops the quad and its projected point", () => {
    const { quads, projected } = buildSurfaceScene(
      [0, 1], [0, 1],
      [[0, null], [2, 3]],
      [[0, 1], [2, 3]],
      flatProject, color,
    );
    expect(quads).toHaveLength(0);
    expect(projected).toHaveLength(3);
  });

  test("null pointIndices entries are skipped but quads survive", () => {
    const { quads, projected } = buildSurfaceScene(
      [0, 1], [0, 1],
      [[0, 1], [2, 3]],
      [[0, null], [null, 3]],
      flatProject, color,
    );
    expect(quads).toHaveLength(1);
    expect(projected.map((p) => p.idx)).toEqual([0, 3]);
  });

  test("3x3 grid yields 4 quads, sorted back-to-front", () => {
    const { quads } = buildSurfaceScene(
      [0, 1, 2], [0, 1, 2],
      [[0, 1, 2], [3, 4, 5], [6, 7, 8]],
      [[null, null, null], [null, null, null], [null, null, null]],
      flatProject, color,
    );
    expect(quads).toHaveLength(4);
    for (let i = 1; i < quads.length; i++) {
      expect(quads[i]!.z).toBeLessThanOrEqual(quads[i - 1]!.z);
    }
  });

  test("colorForZ receives the mean of the four corner values", () => {
    const seen: number[] = [];
    buildSurfaceScene(
      [0, 1], [0, 1],
      [[0, 1], [2, 3]],
      [[null, null], [null, null]],
      flatProject,
      (z) => { seen.push(z); return "x"; },
    );
    expect(seen).toEqual([1.5]);
  });
});

describe("findClosestProjected", () => {
  const pts = [
    { sx: 0, sy: 0, idx: 1 },
    { sx: 5, sy: 5, idx: 2 },
    { sx: 100, sy: 100, idx: 3 },
  ];

  test("picks the nearest point within radius", () => {
    expect(findClosestProjected(pts, 1, 1, 20)).toBe(1);
    expect(findClosestProjected(pts, 4, 4, 20)).toBe(2);
  });

  test("returns null when nothing is inside the radius", () => {
    expect(findClosestProjected(pts, 50, 50, 20)).toBeNull();
    expect(findClosestProjected([], 0, 0, 20)).toBeNull();
  });
});

describe("pickTicks", () => {
  test("nice steps over 0..10", () => {
    expect(pickTicks(0, 10, 5)).toEqual([0, 2.5, 5, 7.5, 10]);
  });

  test("degenerate range returns the single value", () => {
    expect(pickTicks(3, 3, 5)).toEqual([3]);
    expect(pickTicks(5, 2, 5)).toEqual([5]);
  });

  test("ticks stay within [min, max] (up to rounding slack)", () => {
    const ticks = pickTicks(1.2, 9.7, 5);
    expect(ticks.length).toBeGreaterThan(0);
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(1.2);
      expect(t).toBeLessThanOrEqual(9.7 + 1e-9);
    }
  });
});
