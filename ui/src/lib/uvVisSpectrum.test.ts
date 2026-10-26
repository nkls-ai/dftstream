import { test, expect } from "bun:test";
import { computeUVVisSpectrum, parseTransitions } from "./uvVisSpectrum";

test("computeUVVisSpectrum returns empty for no states", () => {
  expect(computeUVVisSpectrum([])).toEqual([]);
});

test("computeUVVisSpectrum returns empty for zero-fosc states", () => {
  const states = [
    { idx: 0, energyEv: 3.0, wavelengthNm: 413, oscStrength: 0, transitions: undefined },
  ];
  expect(computeUVVisSpectrum(states)).toEqual([]);
});

test("computeUVVisSpectrum produces Gaussian-broadened curve", () => {
  const states = [
    { idx: 0, energyEv: 4.0, wavelengthNm: 310, oscStrength: 0.5 },
    { idx: 1, energyEv: 5.0, wavelengthNm: 248, oscStrength: 0.1 },
  ];
  const data = computeUVVisSpectrum(states, { xMin: 200, xMax: 400, nPoints: 201 });
  expect(data.length).toBe(201);

  // Peak near 310 nm should be higher than peak near 248 nm (fosc 0.5 vs 0.1)
  const peak310 = data.find((d) => Math.abs(d.x - 310) < 2);
  const peak248 = data.find((d) => Math.abs(d.x - 248) < 2);
  expect(peak310).toBeDefined();
  expect(peak248).toBeDefined();
  expect(peak310!.y).toBeGreaterThan(peak248!.y);

  // Peak at 310 should have significant intensity
  expect(peak310!.y).toBeGreaterThan(0.01);
});

test("computeUVVisSpectrum respects fwhm", () => {
  const states = [{ idx: 0, energyEv: 4.0, wavelengthNm: 300, oscStrength: 1.0 }];
  const narrow = computeUVVisSpectrum(states, { xMin: 200, xMax: 400, fwhm: 5, nPoints: 201 });
  const wide = computeUVVisSpectrum(states, { xMin: 200, xMax: 400, fwhm: 40, nPoints: 201 });

  const narrowPeak = Math.max(...narrow.map((d) => d.y));
  const widePeak = Math.max(...wide.map((d) => d.y));
  // Narrower FWHM → taller peak
  expect(narrowPeak).toBeGreaterThan(widePeak);
});

test("parseTransitions parses JSON correctly", () => {
  const json = JSON.stringify([
    { from: "137a", to: "138a", coeff: 0.8358 },
    { from: "136a", to: "138a", coeff: 0.3160 },
  ]);
  const result = parseTransitions(json);
  expect(result.length).toBe(2);
  expect(result[0]!.from).toBe("137a");
  expect(result[0]!.pct).toBe(70); // 0.8358^2 ≈ 0.6986 → 70%
  expect(result[1]!.pct).toBe(10); // 0.316^2 ≈ 0.0999 → 10%
});

test("parseTransitions returns empty for undefined", () => {
  expect(parseTransitions(undefined)).toEqual([]);
});

test("parseTransitions returns empty for invalid JSON", () => {
  expect(parseTransitions("not json")).toEqual([]);
});
