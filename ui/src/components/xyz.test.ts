import { describe, expect, test } from "bun:test";
import { parseMultiXYZ, parseXYZPositions } from "./xyz";

const FRAME = "3\nwater\nO 0.0 0.0 0.117\nH 0.0 0.757 -0.468\nH 0.0 -0.757 -0.468\n";

describe("parseMultiXYZ", () => {
  test("splits a concatenated trajectory into frames", () => {
    const frames = parseMultiXYZ(FRAME + FRAME);
    expect(frames).toHaveLength(2);
    expect(frames[0]!.startsWith("3\nwater")).toBe(true);
  });

  test("skips garbage and incomplete trailing frames", () => {
    expect(parseMultiXYZ("not xyz at all")).toEqual([]);
    expect(parseMultiXYZ("3\nwater\nO 0 0 0\n")).toEqual([]);
  });
});

describe("parseXYZPositions", () => {
  test("returns [x,y,z] per atom", () => {
    const pos = parseXYZPositions(FRAME);
    expect(pos).toHaveLength(3);
    expect(pos[0]).toEqual([0, 0, 0.117]);
    expect(pos[1]![1]).toBeCloseTo(0.757, 6);
  });

  test("returns [] on malformed header", () => {
    expect(parseXYZPositions("abc\ncomment\nO 0 0 0")).toEqual([]);
    expect(parseXYZPositions("")).toEqual([]);
  });
});
