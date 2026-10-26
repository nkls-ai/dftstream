import { expect, test } from "bun:test";
import { DEFAULT_SETTINGS, parseSettings } from "./settingsSchema";

test("non-object blobs fall back to the defaults", () => {
  expect(parseSettings(undefined)).toEqual({ ...DEFAULT_SETTINGS });
  expect(parseSettings(null)).toEqual({ ...DEFAULT_SETTINGS });
  expect(parseSettings([1, 2])).toEqual({ ...DEFAULT_SETTINGS });
  expect(parseSettings("light")).toEqual({ ...DEFAULT_SETTINGS });
});

test("valid fields are kept", () => {
  const s = parseSettings({
    theme: "light",
    energyDecimals: 12,
    energyUnit: "kcal",
    timeFormat: "24h",
    viewerStyle: "stick",
    viewerSpin: true,
    experimentPageSize: 10,
    irScaleFactors: { B3LYP: 0.965 },
    spMethod: "HF def2-SVP",
  });
  expect(s.theme).toBe("light");
  expect(s.energyDecimals).toBe(12);
  expect(s.energyUnit).toBe("kcal");
  expect(s.timeFormat).toBe("24h");
  expect(s.viewerStyle).toBe("stick");
  expect(s.viewerSpin).toBe(true);
  expect(s.experimentPageSize).toBe(10);
  expect(s.irScaleFactors).toEqual({ B3LYP: 0.965 });
  expect(s.spMethod).toBe("HF def2-SVP");
});

test("each invalid field falls back to its own default without touching the others", () => {
  const s = parseSettings({
    theme: "neon",
    energyDecimals: 7,
    energyUnit: "hartree",
    timeFormat: 24,
    viewerStyle: null,
    viewerSpin: "yes",
    simpleMode: false,
    experimentPageSize: "50",
    irScaleFactors: { good: 0.97, bad: "x", inf: Infinity },
    spMethod: 42,
  });
  expect(s.theme).toBe(DEFAULT_SETTINGS.theme);
  expect(s.energyDecimals).toBe(DEFAULT_SETTINGS.energyDecimals);
  expect(s.energyUnit).toBe(DEFAULT_SETTINGS.energyUnit);
  expect(s.timeFormat).toBe(DEFAULT_SETTINGS.timeFormat);
  expect(s.viewerStyle).toBe(DEFAULT_SETTINGS.viewerStyle);
  expect(s.viewerSpin).toBe(DEFAULT_SETTINGS.viewerSpin);
  expect(s.simpleMode).toBe(false);
  expect(s.experimentPageSize).toBe(DEFAULT_SETTINGS.experimentPageSize);
  expect(s.irScaleFactors).toEqual({ good: 0.97 });
  expect(s.spMethod).toBe(DEFAULT_SETTINGS.spMethod);
});

test("parsed irScaleFactors never alias the shared default object", () => {
  const a = parseSettings(undefined);
  a.irScaleFactors.X = 1;
  expect(DEFAULT_SETTINGS.irScaleFactors).toEqual({});
});
