import { describe, expect, test } from "bun:test";
import type { Run } from "../data/types";
import { profilePoint, reactionEnergetics } from "./reactionProfile";

function run(over: Partial<Run>): Run {
  return { id: "r", experimentId: "e", status: "finished", startedAt: 0, ...over } as Run;
}

// -100 Eh reactant, TS 0.02 Eh above it, product 0.01 Eh below.
const reactant = run({ lastEnergy: -100.0, gibbsEh: -99.95, gMinusEEh: 0.05 });
const ts = run({ lastEnergy: -99.98, gibbsEh: -99.94, gMinusEEh: 0.04 });
const product = run({ lastEnergy: -100.01, gibbsEh: -99.96, gMinusEEh: 0.05 });

describe("profilePoint", () => {
  test("uses the run's own energies without a single point", () => {
    const p = profilePoint("Reactant", reactant)!;
    expect(p.eEh).toBe(-100.0);
    expect(p.gEh).toBeCloseTo(-99.95, 10);
    expect(p.refined).toBe(false);
  });

  test("a single point replaces E and rebuilds G as a composite", () => {
    const sp = run({ lastEnergy: -100.5 });
    const p = profilePoint("Reactant", reactant, sp)!;
    expect(p.eEh).toBe(-100.5);
    // E(SP) + (G − E)low = -100.5 + 0.05
    expect(p.gEh).toBeCloseTo(-100.45, 10);
    expect(p.refined).toBe(true);
  });

  test("no run means no point", () => {
    expect(profilePoint("Reactant", undefined)).toBeUndefined();
  });
});

describe("reactionEnergetics", () => {
  const points = {
    reactant: profilePoint("Reactant", reactant),
    ts: profilePoint("TS", ts),
    product: profilePoint("Product", product),
  };

  test("barriers and reaction energy in kcal/mol", () => {
    const e = reactionEnergetics(points);
    expect(e.barrierFwdKcal).toBeCloseTo(0.02 * 627.5094740631, 6);
    expect(e.barrierRevKcal).toBeCloseTo(0.03 * 627.5094740631, 6);
    expect(e.reactionKcal).toBeCloseTo(-0.01 * 627.5094740631, 6);
    expect(e.barrierFwdGKcal).toBeCloseTo(0.01 * 627.5094740631, 6);
    expect(e.mixedLevels).toBe(false);
  });

  test("missing points leave the affected quantities undefined", () => {
    const e = reactionEnergetics({ reactant: points.reactant, ts: points.ts });
    expect(e.barrierFwdKcal).toBeDefined();
    expect(e.reactionKcal).toBeUndefined();
    expect(e.barrierRevKcal).toBeUndefined();
  });

  test("partial refinement is flagged as mixed levels of theory", () => {
    const e = reactionEnergetics({
      ...points,
      ts: profilePoint("TS", ts, run({ lastEnergy: -100.4 })),
    });
    expect(e.mixedLevels).toBe(true);
  });
});
