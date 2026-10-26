import { describe, expect, test } from "bun:test";
import type { VibBlob } from "../data/DataSource";
import { EMPTY_THERMO } from "./runDetailParsers";
import {
  buildCycleEnergySeries,
  groupVibModes,
  hasThermoData,
  resolveIrScale,
  usesRecalcHess,
} from "./tsTabLogic";

function vib(id: string, name: string, contentText: string): VibBlob {
  return { id, name, contentText };
}

describe("groupVibModes", () => {
  test("splits final-hessian modes from intermediate-hessian modes", () => {
    const { vibByMode, hessianOptions } = groupVibModes([
      vib("a", "job.v6.xyz", "final-6"),
      vib("b", "job.h2.v6.xyz", "hess2-6"),
      vib("c", "job.h10.v7.xyz", "hess10-7"),
      vib("d", "not-a-vib.txt", "ignored"),
    ]);
    expect(vibByMode.final.get(6)).toBe("final-6");
    expect(vibByMode.byHess.get("2")?.get(6)).toBe("hess2-6");
    expect(vibByMode.byHess.get("10")?.get(7)).toBe("hess10-7");
    expect(hessianOptions).toEqual(["final", "10", "2"]);
  });

  test("undefined input yields only the final option", () => {
    const { vibByMode, hessianOptions } = groupVibModes(undefined);
    expect(vibByMode.final.size).toBe(0);
    expect(hessianOptions).toEqual(["final"]);
  });
});

describe("buildCycleEnergySeries", () => {
  test("dedupes by cycle (last value wins) and sorts by cycle", () => {
    const series = buildCycleEnergySeries([
      { ts: 0, cycle: 2, value: -75.2 },
      { ts: 1, cycle: 1, value: -75.1 },
      { ts: 2, cycle: 2, value: -75.25 },
    ]);
    expect(series).toEqual([
      { x: 1, y: -75.1 },
      { x: 2, y: -75.25 },
    ]);
  });

  test("missing cycle buckets under 0", () => {
    expect(buildCycleEnergySeries([{ ts: 0, value: -75 }])).toEqual([{ x: 0, y: -75 }]);
  });

  test("undefined input yields an empty series", () => {
    expect(buildCycleEnergySeries(undefined)).toEqual([]);
  });
});

describe("usesRecalcHess", () => {
  test("matches Calc_Hess and Recalc_Hess with true or numeric values", () => {
    expect(usesRecalcHess("%geom\n  Calc_Hess true\nend")).toBe(true);
    expect(usesRecalcHess("%geom Recalc_Hess 5 end")).toBe(true);
  });

  test("requires a word boundary and an argument", () => {
    expect(usesRecalcHess("xcalc_hess true")).toBe(false);
    expect(usesRecalcHess("Calc_Hess false")).toBe(false);
    expect(usesRecalcHess(undefined)).toBe(false);
  });
});

describe("resolveIrScale", () => {
  test("user functional/basis override wins over presets", () => {
    expect(resolveIrScale({ "B3LYP/def2-SVP": 0.91 }, "B3LYP", "def2-SVP")).toBe(0.91);
  });

  test("functional-only override wins over the preset lookup", () => {
    expect(resolveIrScale({ B3LYP: 0.92 }, "B3LYP", "def2-SVP")).toBe(0.92);
  });

  test("falls back to the built-in presets, then undefined", () => {
    expect(resolveIrScale({}, "B3LYP", "def2-SVP")).toBe(0.97);
    expect(resolveIrScale({}, "NOTAFUNCTIONAL", "nope")).toBeUndefined();
  });
});

describe("hasThermoData", () => {
  test("null or all-empty thermo has no data", () => {
    expect(hasThermoData(null)).toBe(false);
    expect(hasThermoData(EMPTY_THERMO)).toBe(false);
  });

  test("any of zpe, enthalpy, or gibbs counts as data", () => {
    expect(hasThermoData({ ...EMPTY_THERMO, zpeEh: 0.01 })).toBe(true);
    expect(hasThermoData({ ...EMPTY_THERMO, enthalpyEh: -75 })).toBe(true);
    expect(hasThermoData({ ...EMPTY_THERMO, gibbsEh: -75 })).toBe(true);
    // entropy alone does not (matches the original render condition)
    expect(hasThermoData({ ...EMPTY_THERMO, entropyEh: 0.01 })).toBe(false);
  });
});
