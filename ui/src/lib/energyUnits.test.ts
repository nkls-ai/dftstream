import { expect, test } from "bun:test";
import { HARTREE_TO_KCAL } from "./constants";
import {
  EMPTY_ENERGY,
  formatEh,
  formatRelEnergy,
  kcalToEh,
  relEnergyFormat,
} from "./energyUnits";

test("formatEh honours the requested precision", () => {
  expect(formatEh(-76.0266327341, 6)).toBe("-76.026633");
  expect(formatEh(-76.0266327341, 8)).toBe("-76.02663273");
});

test("formatEh renders missing / non-finite energies as the shared placeholder", () => {
  expect(formatEh(null, 8)).toBe(EMPTY_ENERGY);
  expect(formatEh(undefined, 8)).toBe(EMPTY_ENERGY);
  expect(formatEh(Number.NaN, 8)).toBe(EMPTY_ENERGY);
});

test("formatRelEnergy converts and uses per-unit precision", () => {
  const eh = 1 / HARTREE_TO_KCAL; // exactly 1 kcal/mol
  expect(formatRelEnergy("kcal", eh)).toBe("1.00");
  expect(formatRelEnergy("kcal", eh, 1)).toBe("1.000");
  expect(formatRelEnergy("eh", 0.0015936)).toBe("0.001594");
  expect(formatRelEnergy("kcal", null)).toBe(EMPTY_ENERGY);
});

test("kcalToEh inverts the kcal conversion", () => {
  expect(kcalToEh(HARTREE_TO_KCAL)).toBeCloseTo(1, 12);
});

test("relEnergyFormat bundles label, conversions and formatters", () => {
  const kj = relEnergyFormat("kj");
  expect(kj.label).toBe("kJ/mol");
  expect(kj.fromKcal(1)).toBeCloseTo(4.184, 3);
  expect(kj.formatKcal(1)).toBe("4.2");
  expect(kj.formatKcal(undefined)).toBe(EMPTY_ENERGY);

  const kcal = relEnergyFormat("kcal");
  expect(kcal.fromEh(1)).toBeCloseTo(HARTREE_TO_KCAL, 9);
  expect(kcal.formatKcal(12.345, 1)).toBe("12.345");
  expect(kcal.format(0)).toBe("0.00");
  expect(kcal.formatValue(3.14159)).toBe("3.14");
  expect(kcal.formatValue(Number.NaN)).toBe(EMPTY_ENERGY);
});

test("seriesFromKcal re-expresses y and keeps the other fields", () => {
  const ev = relEnergyFormat("ev");
  const [p] = ev.seriesFromKcal([{ x: 2, y: HARTREE_TO_KCAL, tag: "a" }]);
  expect(p!.x).toBe(2);
  expect(p!.tag).toBe("a");
  expect(p!.y).toBeCloseTo(27.211, 3);
  expect(relEnergyFormat("kcal").seriesFromKcal([{ y: 1.5 }])[0]!.y).toBeCloseTo(1.5, 12);
});
