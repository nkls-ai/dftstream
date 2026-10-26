import { test, expect, describe } from "bun:test";
import { computeIRSpectrum, computeFreqSpectrum, hasIRData, lookupScaleFactor, IR_SCALE_PRESETS } from "./irSpectrum";

describe("computeIRSpectrum", () => {
  test("empty input returns empty", () => {
    expect(computeIRSpectrum([])).toEqual([]);
  });

  test("single peak produces correct shape", () => {
    const freqs = [{ wavenumber: 1000, irIntensity: 100 }];
    const spectrum = computeIRSpectrum(freqs, { xMin: 900, xMax: 1100, nPoints: 201 });
    expect(spectrum).toHaveLength(201);

    const peak = spectrum.reduce((a, b) => (b.y > a.y ? b : a));
    expect(peak.x).toBeCloseTo(1000, 0);

    const edges = spectrum.filter((p) => Math.abs(p.x - 1000) > 80);
    for (const e of edges) {
      expect(e.y).toBeLessThan(peak.y * 0.1);
    }
  });

  test("two peaks are both present", () => {
    const freqs = [
      { wavenumber: 1000, irIntensity: 50 },
      { wavenumber: 3000, irIntensity: 100 },
    ];
    const spectrum = computeIRSpectrum(freqs, { xMin: 400, xMax: 4000, nPoints: 500 });

    const near1000 = spectrum.filter((p) => Math.abs(p.x - 1000) < 5);
    const near3000 = spectrum.filter((p) => Math.abs(p.x - 3000) < 5);
    const midValley = spectrum.filter((p) => Math.abs(p.x - 2000) < 5);

    expect(near1000[0]!.y).toBeGreaterThan(midValley[0]!.y);
    expect(near3000[0]!.y).toBeGreaterThan(midValley[0]!.y);
    expect(near3000[0]!.y).toBeGreaterThan(near1000[0]!.y);
  });

  test("zero-intensity peaks are ignored", () => {
    const freqs = [
      { wavenumber: 1000, irIntensity: 0 },
      { wavenumber: 2000, irIntensity: 50 },
    ];
    const spectrum = computeIRSpectrum(freqs, { xMin: 900, xMax: 1100, nPoints: 50 });
    const maxY = Math.max(...spectrum.map((p) => p.y));
    expect(maxY).toBeLessThan(1);
  });
});

describe("IR scaling factors", () => {
  test("computeIRSpectrum shifts peak with scaleFactor", () => {
    const freqs = [{ wavenumber: 1000, irIntensity: 100 }];
    const unscaled = computeIRSpectrum(freqs, { xMin: 800, xMax: 1200, nPoints: 401 });
    const scaled = computeIRSpectrum(freqs, { xMin: 800, xMax: 1200, nPoints: 401, scaleFactor: 0.96 });

    const unscaledPeak = unscaled.reduce((a, b) => (b.y > a.y ? b : a));
    const scaledPeak = scaled.reduce((a, b) => (b.y > a.y ? b : a));

    expect(unscaledPeak.x).toBeCloseTo(1000, 0);
    expect(scaledPeak.x).toBeCloseTo(960, 1);
  });

  test("computeFreqSpectrum shifts peak with scaleFactor", () => {
    const freqs = [{ wavenumber: 3000, irIntensity: 50 }];
    const scaled = computeFreqSpectrum(freqs, { xMin: 2700, xMax: 3100, nPoints: 401, scaleFactor: 0.95 });
    const peak = scaled.reduce((a, b) => (b.y > a.y ? b : a));
    expect(peak.x).toBeCloseTo(2850, 0);
  });

  test("lookupScaleFactor finds known method/basis", () => {
    expect(lookupScaleFactor("B3LYP", "def2-TZVPP")).toBe(0.9750);
    expect(lookupScaleFactor("r2SCAN-3c", undefined)).toBe(0.9710);
  });

  test("lookupScaleFactor returns undefined for unknown", () => {
    expect(lookupScaleFactor("UNKNOWN", "fake-basis")).toBeUndefined();
    expect(lookupScaleFactor(undefined, undefined)).toBeUndefined();
  });

  test("IR_SCALE_PRESETS has reasonable values", () => {
    for (const [key, value] of Object.entries(IR_SCALE_PRESETS)) {
      expect(value).toBeGreaterThan(0.8);
      expect(value).toBeLessThan(1.1);
      expect(key.length).toBeGreaterThan(0);
    }
  });
});

describe("hasIRData", () => {
  test("returns false for no intensity", () => {
    expect(hasIRData([{ irIntensity: undefined }, { irIntensity: 0 }])).toBe(false);
  });
  test("returns true when any intensity present", () => {
    expect(hasIRData([{ irIntensity: undefined }, { irIntensity: 5.0 }])).toBe(true);
  });
});
