import { describe, expect, test } from "bun:test";
import type { NMRShieldRow } from "../data/DataSource";
import {
  buildShiftTable,
  computeNMRSpectrum,
  isSupportedNMRNucleus,
  nucleusLabel,
  SUPPORTED_NMR_NUCLEI,
  TMS_REFERENCES,
} from "./nmrSpectrum";

function row(partial: Partial<NMRShieldRow> & { element: string; isotropic: number }): NMRShieldRow {
  return { id: `${partial.element}-${partial.isotropic}`, atomIdx: 0, anisotropy: 0, ...partial };
}

describe("computeNMRSpectrum", () => {
  test("returns empty array when no atoms match the nucleus", () => {
    const shields = [row({ element: "C", isotropic: 150 })];
    expect(computeNMRSpectrum(shields, "H", TMS_REFERENCES.H)).toEqual([]);
  });

  test("defaults to 500 points spanning shifts padded by 2 ppm", () => {
    const shields = [
      row({ element: "H", isotropic: 30 }),
      row({ element: "H", isotropic: 25 }),
    ];
    const spectrum = computeNMRSpectrum(shields, "H", 31.7);
    expect(spectrum).toHaveLength(500);
    // shifts are 1.7 and 6.7 ppm; range padded by 2 on each side
    expect(spectrum[0]?.x).toBeCloseTo(-0.3, 10);
    expect(spectrum[499]?.x).toBeCloseTo(8.7, 10);
  });

  test("peaks at each chemical shift with unit height per atom", () => {
    const shields = [row({ element: "H", isotropic: 29.7 })];
    // shift = 2.0; put a grid point exactly on the peak
    const spectrum = computeNMRSpectrum(shields, "H", 31.7, {
      xMin: 0,
      xMax: 4,
      nPoints: 5,
    });
    expect(spectrum).toHaveLength(5);
    expect(spectrum.map((p) => p.x)).toEqual([0, 1, 2, 3, 4]);
    const peak = spectrum[2];
    expect(peak?.y).toBeCloseTo(1, 6);
    // far from the peak the Gaussian is effectively zero
    expect(spectrum[0]?.y ?? 1).toBeLessThan(1e-6);
  });

  test("overlapping atoms sum their intensities", () => {
    const shields = [
      row({ id: "a", element: "C", isotropic: 100 }),
      row({ id: "b", element: "C", isotropic: 100 }),
    ];
    // degenerate range: both grid points sit exactly on the shared peak
    const spectrum = computeNMRSpectrum(shields, "C", 182.4, {
      xMin: 82.4,
      xMax: 82.4,
      nPoints: 2,
    });
    expect(spectrum[0]?.y).toBeCloseTo(2, 6);
  });

  test("honors a custom fwhm", () => {
    const shields = [row({ element: "H", isotropic: 29.7 })];
    const at = (fwhm: number) =>
      computeNMRSpectrum(shields, "H", 31.7, { xMin: 2.5, xMax: 2.5, nPoints: 2, fwhm })[0]?.y ?? 0;
    // broader line keeps more intensity half a ppm off-peak
    expect(at(1)).toBeGreaterThan(at(0.05));
  });
});

describe("buildShiftTable", () => {
  test("filters to the nucleus, computes shift, sorts descending", () => {
    const shields = [
      row({ id: "h1", element: "H", isotropic: 30 }),
      row({ id: "c1", element: "C", isotropic: 100 }),
      row({ id: "h2", element: "H", isotropic: 25 }),
    ];
    const table = buildShiftTable(shields, "H", 31.7);
    expect(table.map((r) => r.id)).toEqual(["h2", "h1"]);
    expect(table[0]?.shift).toBeCloseTo(6.7, 10);
    expect(table[1]?.shift).toBeCloseTo(1.7, 10);
  });
});

describe("nucleus helpers", () => {
  test("nucleusLabel maps H and C to their NMR-active isotopes", () => {
    expect(nucleusLabel("H")).toEqual({ mass: "1" });
    expect(nucleusLabel("C")).toEqual({ mass: "13" });
    expect(nucleusLabel("N")).toEqual({ mass: "" });
  });

  test("isSupportedNMRNucleus accepts only supported nuclei", () => {
    for (const n of SUPPORTED_NMR_NUCLEI) expect(isSupportedNMRNucleus(n)).toBe(true);
    expect(isSupportedNMRNucleus("N")).toBe(false);
    expect(isSupportedNMRNucleus("")).toBe(false);
  });

  test("TMS references match the hard-coded sigma values", () => {
    expect(TMS_REFERENCES.H).toBe(31.7);
    expect(TMS_REFERENCES.C).toBe(182.4);
  });
});
