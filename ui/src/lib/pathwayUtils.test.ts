import { test, expect, describe } from "bun:test";
import { EH_TO_KCAL } from "./constants";
import {
  computeRelativeEnergies,
  computeBarrierHeight,
  computeReactionEnergy,
  interpolateProfile,
  basisEnergyEh,
  checkPathwayConsistency,
  MAX_PLAUSIBLE_SPAN_KCAL,
  PathwayIssueKind,
  xyzFormula,
} from "./pathwayUtils";

describe("basisEnergyEh", () => {
  const run = { lastEnergy: -100.0, enthalpyEh: -99.9, gibbsEh: -99.95 };

  test("selects the field matching the basis", () => {
    expect(basisEnergyEh(run, "E")).toBe(-100.0);
    expect(basisEnergyEh(run, "H")).toBe(-99.9);
    expect(basisEnergyEh(run, "G")).toBe(-99.95);
  });

  test("missing thermochemistry yields undefined, not the electronic energy", () => {
    const noFreq = { lastEnergy: -100.0 };
    expect(basisEnergyEh(noFreq, "E")).toBe(-100.0);
    expect(basisEnergyEh(noFreq, "H")).toBeUndefined();
    expect(basisEnergyEh(noFreq, "G")).toBeUndefined();
  });

  test("undefined run yields undefined", () => {
    expect(basisEnergyEh(undefined, "G")).toBeUndefined();
  });
});

describe("computeRelativeEnergies", () => {
  test("converts Hartrees to kcal/mol relative to minimum", () => {
    const energies = [-100.0, -99.95, -99.98];
    const rel = computeRelativeEnergies(energies);
    expect(rel[0]).toBeCloseTo(0.0, 4);
    expect(rel[1]).toBeCloseTo(0.05 * EH_TO_KCAL, 4);
    expect(rel[2]).toBeCloseTo(0.02 * EH_TO_KCAL, 4);
  });

  test("empty input returns empty", () => {
    expect(computeRelativeEnergies([])).toEqual([]);
  });

  test("single point returns zero", () => {
    const rel = computeRelativeEnergies([-50.0]);
    expect(rel).toEqual([0]);
  });

  test("equal energies all zero", () => {
    const rel = computeRelativeEnergies([-10, -10, -10]);
    expect(rel).toEqual([0, 0, 0]);
  });
});

describe("computeBarrierHeight", () => {
  test("simple R -> TS -> P pathway", () => {
    const rel = [0, 31.4, 5.0];
    const roles = ["reactant", "ts", "product"] as const;
    const b = computeBarrierHeight(rel, [...roles]);
    expect(b).not.toBeNull();
    expect(b!.forward).toBeCloseTo(31.4, 4);
    expect(b!.reverse).toBeCloseTo(26.4, 4);
  });

  test("no TS returns null", () => {
    const rel = [0, 5.0];
    const roles = ["reactant", "product"] as const;
    expect(computeBarrierHeight(rel, [...roles])).toBeNull();
  });

  test("multiple TSs picks highest", () => {
    const rel = [0, 20, 10, 30, 5];
    const roles = ["reactant", "ts", "intermediate", "ts", "product"] as const;
    const b = computeBarrierHeight(rel, [...roles]);
    expect(b!.forward).toBeCloseTo(30, 4);
    expect(b!.reverse).toBeCloseTo(25, 4);
  });
});

describe("computeReactionEnergy", () => {
  test("exothermic reaction", () => {
    const rel = [10, 40, 0];
    const roles = ["reactant", "ts", "product"] as const;
    expect(computeReactionEnergy(rel, [...roles])).toBeCloseTo(-10, 4);
  });

  test("endothermic reaction", () => {
    const rel = [0, 40, 15];
    const roles = ["reactant", "ts", "product"] as const;
    expect(computeReactionEnergy(rel, [...roles])).toBeCloseTo(15, 4);
  });

  test("missing product returns null", () => {
    const rel = [0, 40];
    const roles = ["reactant", "ts"] as const;
    expect(computeReactionEnergy(rel, [...roles])).toBeNull();
  });
});

describe("interpolateProfile", () => {
  test("single point returns it as stationary", () => {
    const pts = [{ x: 0, y: 10 }];
    const result = interpolateProfile(pts);
    expect(result).toHaveLength(1);
    expect(result[0]!.isStationary).toBe(true);
  });

  test("two points produces smooth interpolation", () => {
    const pts = [
      { x: 0, y: 0, label: "R" },
      { x: 1, y: 10, label: "P" },
    ];
    const result = interpolateProfile(pts, 10);
    expect(result.length).toBeGreaterThan(2);
    expect(result[0]!.x).toBe(0);
    expect(result[0]!.isStationary).toBe(true);
    expect(result[result.length - 1]!.x).toBeCloseTo(1, 8);
  });

  test("three points: endpoints and midpoint are stationary", () => {
    const pts = [
      { x: 0, y: 0, role: "reactant" as const },
      { x: 1, y: 30, role: "ts" as const },
      { x: 2, y: 5, role: "product" as const },
    ];
    const result = interpolateProfile(pts, 5);
    const stationary = result.filter((p) => p.isStationary);
    expect(stationary).toHaveLength(3);
    expect(stationary[0]!.y).toBe(0);
    expect(stationary[1]!.y).toBe(30);
    expect(stationary[2]!.y).toBe(5);
  });
});

describe("checkPathwayConsistency", () => {
  const hcn = "3\nHCN\nH 0 0 -1.06\nC 0 0 0\nN 0 0 1.15\n";
  const hnc = "3\nHNC\nH 0 0 -1.0\nN 0 0 0\nC 0 0 1.17\n";
  const water = "3\nwater\nO 0 0 0\nH 0 0.76 0.59\nH 0 -0.76 0.59\n";

  test("xyzFormula reads an .xyz block in Hill order", () => {
    expect(xyzFormula(hcn)).toBe("CHN");
    expect(xyzFormula(hnc)).toBe("CHN");
    expect(xyzFormula(water)).toBe("H2O");
    expect(xyzFormula(undefined)).toBeNull();
    expect(xyzFormula("")).toBeNull();
  });

  test("isomers of one system pass", () => {
    const pts = [
      { name: "hcn", formula: xyzFormula(hcn) },
      { name: "ts", formula: "CHN" },
      { name: "hnc", formula: xyzFormula(hnc) },
    ];
    expect(checkPathwayConsistency(pts, [0, 73.2, 20.0])).toBeNull();
  });

  test("different molecules are flagged whatever the energies", () => {
    const issue = checkPathwayConsistency(
      [
        { name: "hcn", formula: "CHN" },
        { name: "water", formula: "H2O" },
      ],
      [0, 10],
    );
    expect(issue?.kind).toBe(PathwayIssueKind.Composition);
    expect(issue?.message).toContain("water: H2O");
  });

  test("unknown formulas fall back to an energy-spread check", () => {
    const pts = [
      { name: "a", formula: null },
      { name: "b", formula: undefined },
    ];
    expect(checkPathwayConsistency(pts, [0, 50])).toBeNull();
    expect(checkPathwayConsistency(pts, [0, 1_939_569.6])?.kind).toBe(PathwayIssueKind.Magnitude);
    expect(MAX_PLAUSIBLE_SPAN_KCAL).toBeLessThan(1_000);
  });
});
