import { test, expect, describe } from "bun:test";
import { EH_TO_KCAL } from "./constants";
import { groupRunsByMethod, methodFamily } from "./benchmarkUtils";
import type { Run } from "../data/types";

function makeRun(overrides: Partial<Run>): Run {
  return {
    id: Math.random().toString(36).slice(2),
    experimentId: "exp1",
    status: "finished",
    startedAt: Date.now(),
    ...overrides,
  };
}

describe("groupRunsByMethod", () => {
  test("groups runs by functional/basis", () => {
    const runs = [
      makeRun({ functional: "B3LYP", basis: "def2-SVP", lastEnergy: -76.0 }),
      makeRun({ functional: "B3LYP", basis: "def2-TZVP", lastEnergy: -76.1 }),
      makeRun({ functional: "r2SCAN-3c", basis: undefined, lastEnergy: -76.05 }),
    ];
    const groups = groupRunsByMethod(runs);
    expect(groups).toHaveLength(3);
    expect(groups[0]!.relKcal).toBeCloseTo(0, 4);
    expect(groups[0]!.key).toContain("B3LYP");
    expect(groups[0]!.key).toContain("TZVP");
  });

  test("computes relative energies correctly", () => {
    const runs = [
      makeRun({ functional: "HF", basis: "SVP", lastEnergy: -75.9 }),
      makeRun({ functional: "B3LYP", basis: "SVP", lastEnergy: -76.0 }),
    ];
    const groups = groupRunsByMethod(runs);
    expect(groups[0]!.relKcal).toBeCloseTo(0, 4);
    expect(groups[1]!.relKcal).toBeCloseTo(0.1 * EH_TO_KCAL, 2);
  });

  test("filters out non-finished runs", () => {
    const runs = [
      makeRun({ functional: "B3LYP", basis: "SVP", lastEnergy: -76.0 }),
      makeRun({ functional: "HF", basis: "SVP", status: "failed", lastEnergy: -75.0 }),
      makeRun({ functional: "MP2", basis: "SVP", status: "running" }),
    ];
    const groups = groupRunsByMethod(runs);
    expect(groups).toHaveLength(1);
  });

  test("empty input returns empty", () => {
    expect(groupRunsByMethod([])).toEqual([]);
  });

  test("custom reference energy", () => {
    const runs = [
      makeRun({ functional: "B3LYP", basis: "SVP", lastEnergy: -76.0 }),
      makeRun({ functional: "HF", basis: "SVP", lastEnergy: -75.9 }),
    ];
    const groups = groupRunsByMethod(runs, -75.9);
    const hf = groups.find((g) => g.functional === "HF")!;
    expect(hf.relKcal).toBeCloseTo(0, 4);
  });

  test("multiple runs per method picks lowest energy", () => {
    const runs = [
      makeRun({ functional: "B3LYP", basis: "SVP", lastEnergy: -76.0 }),
      makeRun({ functional: "B3LYP", basis: "SVP", lastEnergy: -76.1 }),
    ];
    const groups = groupRunsByMethod(runs);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.bestEnergy).toBe(-76.1);
  });
});

describe("methodFamily", () => {
  test("classifies DFT", () => {
    expect(methodFamily(makeRun({ method: "DFT" }))).toBe("dft");
  });
  test("classifies HF", () => {
    expect(methodFamily(makeRun({ method: "HF" }))).toBe("hf");
  });
  test("classifies xTB", () => {
    expect(methodFamily(makeRun({ method: "tight-binding" }))).toBe("xtb");
  });
  test("classifies post-HF", () => {
    expect(methodFamily(makeRun({ method: "DLPNO-CCSD(T)" }))).toBe("wft");
  });
});
