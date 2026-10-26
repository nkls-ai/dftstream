import type { NMRShieldRow } from "../data/DataSource";

export const SUPPORTED_NMR_NUCLEI = ["H", "C"] as const;
export type SupportedNMRNucleus = (typeof SUPPORTED_NMR_NUCLEI)[number];

export const TMS_REFERENCES: Record<SupportedNMRNucleus, number> = {
  H: 31.7,
  C: 182.4,
};

export function computeNMRSpectrum(
  shields: NMRShieldRow[],
  nucleus: string,
  reference: number,
  opts?: { xMin?: number; xMax?: number; fwhm?: number; nPoints?: number },
): { x: number; y: number }[] {
  const filtered = shields.filter((s) => s.element === nucleus);
  if (filtered.length === 0) return [];

  const shifts = filtered.map((s) => reference - s.isotropic);
  const xMin = opts?.xMin ?? Math.min(...shifts) - 2;
  const xMax = opts?.xMax ?? Math.max(...shifts) + 2;
  const fwhm = opts?.fwhm ?? 0.05;
  const nPoints = opts?.nPoints ?? 500;
  const sigma = fwhm / (2 * Math.sqrt(2 * Math.log(2)));
  const step = (xMax - xMin) / (nPoints - 1);

  const result: { x: number; y: number }[] = [];
  for (let i = 0; i < nPoints; i++) {
    const x = xMin + i * step;
    let y = 0;
    for (const delta of shifts) {
      const dx = x - delta;
      y += Math.exp(-(dx * dx) / (2 * sigma * sigma));
    }
    result.push({ x, y });
  }
  return result;
}

export function nucleusLabel(element: string): { mass: string } {
  switch (element) {
    case "H": return { mass: "1" };
    case "C": return { mass: "13" };
    default: return { mass: "" };
  }
}

export function isSupportedNMRNucleus(element: string): element is SupportedNMRNucleus {
  return (SUPPORTED_NMR_NUCLEI as readonly string[]).includes(element);
}

export interface NMRShiftRow extends NMRShieldRow {
  shift: number;
}

export function buildShiftTable(
  data: NMRShieldRow[],
  nucleus: string,
  reference: number,
): NMRShiftRow[] {
  return data
    .filter((s) => s.element === nucleus)
    .map((s) => ({ ...s, shift: reference - s.isotropic }))
    .sort((a, b) => b.shift - a.shift);
}
