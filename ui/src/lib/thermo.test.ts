import { describe, expect, test } from "bun:test";
import { gMinusElectronicEh } from "./thermo";

describe("gMinusElectronicEh", () => {
  test("prefers the stored G-E(el)", () => {
    expect(gMinusElectronicEh({ gMinusEEh: 0.1, gibbsEh: -1, lastEnergy: -2 })).toBe(0.1);
  });

  test("derives it from G and E(el) when only those were stored", () => {
    // opt-freq_ma1_r2scan3c: G = -422.77823438, E(el) = -422.88693549,
    // ORCA prints G-E(el) = 0.10870112 Eh.
    const v = gMinusElectronicEh({ gibbsEh: -422.77823438, lastEnergy: -422.88693549 });
    expect(v).toBeCloseTo(0.10870111, 8);
  });

  test("undefined without both energies", () => {
    expect(gMinusElectronicEh({ gibbsEh: -1 })).toBeUndefined();
    expect(gMinusElectronicEh({ lastEnergy: -1 })).toBeUndefined();
  });
});
