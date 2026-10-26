import { describe, expect, test } from "bun:test";
import { chunkPathFrames, mergeNEBXYZ, parseNEBInterp, parseNEBInterpIterations, parseNEBOutput } from "./neb";

const NEB_OUT = `
                         NEB OPTIMIZATION
Reactant:
 E ....  -76.400000
Product:
 E ....  -76.390000

 Iter  HEI  E(HEI)-E(0)  max(|Fp|)  RMS(Fp)  dist
 LBFGS   1   4   0.045000   0.012000   0.004000   0.900000
 LBFGS   2   4   0.041000   0.008000   0.002500   0.850000 1 2 3
Climbing image  ....  4

PATH SUMMARY
---------------------------------------------
 image   dist      E(Eh)        dE(kcal/mol)
   0     0.000   -76.400000     0.000
   1     0.512   -76.382000    11.295
   2     1.033   -76.361000    24.472  <= CI
   3     1.545   -76.385000     9.413
---------------------------------------------
HURRAY
`;

describe("parseNEBOutput", () => {
  test("parses iterations, path summary, endpoints and TS image", () => {
    const s = parseNEBOutput(NEB_OUT)!;
    expect(s).not.toBeNull();
    expect(s.iterations).toHaveLength(2);
    expect(s.iterations[0]).toMatchObject({ iter: 1, hei: 4 });
    expect(s.iterations[0]!.barrierEh).toBeCloseTo(0.045, 6);
    expect(s.iterations[1]!.isCI).toBe(true);
    expect(s.finalImages).toHaveLength(4);
    expect(s.finalImages[2]!.energy).toBeCloseTo(24.472, 3);
    expect(s.finalImages[2]!.distance).toBeCloseTo(1.033, 3);
    // "<= CI" marker wins over the "Climbing image" line
    expect(s.tsImageIndex).toBe(2);
    expect(s.reactantEnergy).toBeCloseTo(-76.4, 4);
    expect(s.productEnergy).toBeCloseTo(-76.39, 4);
    expect(s.converged).toBe(true);
  });

  test("returns null for non-NEB output", () => {
    expect(parseNEBOutput("FINAL SINGLE POINT ENERGY -1.0")).toBeNull();
    expect(parseNEBOutput("NEB OPTIMIZATION\nnothing else")).toBeNull();
  });

  test("falls back to the last iteration's HEI when no CI marker exists", () => {
    const out = `NEB OPTIMIZATION
 LBFGS   1   3   0.045000   0.012000   0.004000   0.900000
`;
    expect(parseNEBOutput(out)!.tsImageIndex).toBe(3);
  });
});

const INTERP = `Iteration:  3
Images:
 0.000000   0.000000   0.000000
 1.000000   0.512000   11.295000

Interp.:
 0.000000   0.000000   0.000000
 0.500000   0.256000   6.000000

Iteration:  4
Images:
 0.000000   0.000000   0.000000
 1.000000   0.520000   11.100000

Interp.:
 0.000000   0.000000   0.000000
 0.500000   0.260000   5.900000
`;

describe("parseNEBInterp", () => {
  test("keeps only the last iteration's images and interpolation", () => {
    const { images, interp } = parseNEBInterp(INTERP);
    expect(images).toHaveLength(2);
    expect(images[1]).toMatchObject({ index: 1 });
    expect(images[1]!.distance).toBeCloseTo(0.52, 4);
    expect(images[1]!.energy).toBeCloseTo(11.1, 4);
    expect(interp).toHaveLength(2);
    expect(interp[1]!.energy).toBeCloseTo(5.9, 4);
  });
});

describe("parseNEBInterpIterations", () => {
  test("returns every iteration block in file order", () => {
    const iters = parseNEBInterpIterations(INTERP);
    expect(iters).toHaveLength(2);
    expect(iters[0]!.iter).toBe(3);
    expect(iters[1]!.iter).toBe(4);
    expect(iters[0]!.images[1]!.energy).toBeCloseTo(11.295, 4);
    expect(iters[1]!.images[1]!.energy).toBeCloseTo(11.1, 4);
    expect(iters[0]!.interp).toHaveLength(2);
    expect(iters[1]!.interp[1]!.energy).toBeCloseTo(5.9, 4);
  });

  test("empty for text without iteration blocks", () => {
    expect(parseNEBInterpIterations("no neb here")).toHaveLength(0);
  });
});

describe("chunkPathFrames", () => {
  const frames = ["a", "b", "c", "d", "e", "f"];
  test("splits into equal bands", () => {
    expect(chunkPathFrames(frames, 3)).toEqual([["a", "b", "c"], ["d", "e", "f"]]);
  });
  test("bails on uneven counts and bad sizes", () => {
    expect(chunkPathFrames(frames, 4)).toEqual([]);
    expect(chunkPathFrames(frames, 0)).toEqual([]);
    expect(chunkPathFrames([], 3)).toEqual([]);
  });
});

describe("mergeNEBXYZ", () => {
  test("zips trajectory frames onto images by position", () => {
    const images = [
      { index: 0, distance: 0, energy: 0 },
      { index: 1, distance: 1, energy: 5 },
    ];
    const trj = "1\nframe0\nH 0 0 0\n1\nframe1\nH 0 0 1\n";
    const merged = mergeNEBXYZ(images, trj);
    expect(merged[0]!.xyz).toContain("frame0");
    expect(merged[1]!.xyz).toContain("frame1");
    expect(mergeNEBXYZ(images, undefined)[0]!.xyz).toBeUndefined();
  });
});
