import { describe, expect, test } from "bun:test";
import { buildTree, findLandmarks, formatEnergy } from "./artifactsLandmarks";

describe("findLandmarks", () => {
  test("returns empty for lines with no landmarks", () => {
    expect(findLandmarks(["hello", "world", ""])).toEqual([]);
  });

  test("captures line index and builds labels from captures", () => {
    const lines = [
      "noise",
      "         *   GEOMETRY OPTIMIZATION CYCLE   3   *",
      "SCF CONVERGED AFTER  14 CYCLES",
      "FINAL SINGLE POINT ENERGY      -230.987654321",
    ];
    const lms = findLandmarks(lines);
    expect(lms).toEqual([
      { lineIdx: 1, kind: "optCycle", label: "Opt cycle 3", cycle: 3 },
      { lineIdx: 2, kind: "scfConverged", label: "SCF converged (14 iter)" },
      { lineIdx: 3, kind: "finalSp", label: "Final SP · -230.98765432 Eh" },
    ]);
  });

  test("stops at the first matching pattern per line", () => {
    // matches the capture variant, not the bare "SCF CONVERGED AFTER" fallback
    const lms = findLandmarks(["SCF CONVERGED AFTER   5 CYCLES"]);
    expect(lms).toHaveLength(1);
    expect(lms[0]?.label).toBe("SCF converged (5 iter)");
  });

  test("recognizes anchored section headers only at line starts", () => {
    expect(findLandmarks(["INPUT FILE"])[0]?.kind).toBe("input");
    expect(findLandmarks(["some INPUT FILE mention"])).toEqual([]);
    expect(findLandmarks(["Total Energy       :  -76.32642 Eh"])[0]?.kind).toBe("totalEnergy");
    expect(findLandmarks(["  ORBITAL ENERGIES"])[0]?.kind).toBe("homoLumo");
  });

  test("labels dipole magnitude and spin contamination with values", () => {
    const lms = findLandmarks([
      "Magnitude (Debye)      :      1.8324",
      "Expectation value of <S**2>     =     0.7551",
    ]);
    expect(lms[0]?.label).toBe("Dipole · 1.8324 D");
    expect(lms[1]?.label).toBe("<S**2> = 0.7551");
  });
});

describe("buildTree", () => {
  test("nests non-top-level landmarks under the preceding opt cycle", () => {
    const tree = buildTree(
      findLandmarks([
        "GEOMETRY OPTIMIZATION CYCLE   1",
        "SCF ITERATIONS",
        "SCF CONVERGED AFTER   9 CYCLES",
        "GEOMETRY OPTIMIZATION CYCLE   2",
        "SCF CONVERGED AFTER   4 CYCLES",
      ]),
    );
    expect(tree).toHaveLength(2);
    expect(tree[0]?.children.map((c) => c.kind)).toEqual(["scfIter", "scfConverged"]);
    expect(tree[1]?.children.map((c) => c.kind)).toEqual(["scfConverged"]);
  });

  test("marks the last opt cycle converged and the final SP under the converged node", () => {
    const tree = buildTree(
      findLandmarks([
        "GEOMETRY OPTIMIZATION CYCLE   1",
        "GEOMETRY OPTIMIZATION CYCLE   2",
        "THE OPTIMIZATION HAS CONVERGED",
        "FINAL SINGLE POINT ENERGY   -1.5",
      ]),
    );
    expect(tree.map((n) => n.kind)).toEqual(["optCycle", "optCycle", "convergedOpt"]);
    expect(tree[0]?.flags.convergedCycle).toBeUndefined();
    expect(tree[1]?.flags.convergedCycle).toBe(true);
    const converged = tree[2];
    expect(converged?.children).toHaveLength(1);
    expect(converged?.children[0]?.kind).toBe("finalSp");
    expect(converged?.children[0]?.flags.finalConverged).toBe(true);
  });

  test("keeps orphan non-top-level landmarks at the root", () => {
    const tree = buildTree(findLandmarks(["FINAL SINGLE POINT ENERGY   -2.0"]));
    expect(tree).toHaveLength(1);
    expect(tree[0]?.kind).toBe("finalSp");
    expect(tree[0]?.flags.finalConverged).toBeUndefined();
  });

  test("top-level landmarks reset the current parent", () => {
    const tree = buildTree(
      findLandmarks([
        "GEOMETRY OPTIMIZATION CYCLE   1",
        "VIBRATIONAL FREQUENCIES",
        "Total Energy       :  -3.0 Eh",
      ]),
    );
    expect(tree.map((n) => n.kind)).toEqual(["optCycle", "freqs", "totalEnergy"]);
    expect(tree[0]?.children).toHaveLength(0);
  });
});

describe("formatEnergy", () => {
  test("formats finite numbers at the requested precision", () => {
    expect(formatEnergy("-230.9876543", 6)).toBe("-230.987654");
    expect(formatEnergy("1E-3", 6)).toBe("0.001000");
    expect(formatEnergy("-230.9876543", 8)).toBe("-230.98765430");
  });

  test("passes through non-numeric strings unchanged", () => {
    expect(formatEnergy("abc", 6)).toBe("abc");
    // an empty capture is a missing value, not zero
    expect(formatEnergy("", 6)).toBe("—");
  });

  test("findLandmarks honours the energy precision", () => {
    expect(findLandmarks(["FINAL SINGLE POINT ENERGY   -1.5"], 6)[0]?.label).toBe("Final SP · -1.500000 Eh");
  });
});
