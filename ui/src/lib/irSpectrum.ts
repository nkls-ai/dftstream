export interface IRSpectrumOptions {
  xMin?: number;
  xMax?: number;
  halfWidth?: number;
  nPoints?: number;
  scaleFactor?: number;
}

export function computeIRSpectrum(
  freqs: { wavenumber: number; irIntensity: number }[],
  opts?: IRSpectrumOptions,
): { x: number; y: number }[] {
  const xMin = opts?.xMin ?? 400;
  const xMax = opts?.xMax ?? 4000;
  const gamma = opts?.halfWidth ?? 15;
  const nPoints = opts?.nPoints ?? 500;
  const scale = opts?.scaleFactor ?? 1.0;

  if (freqs.length === 0 || nPoints < 2) return [];

  const step = (xMax - xMin) / (nPoints - 1);
  const g2 = gamma * gamma;
  const result: { x: number; y: number }[] = [];

  for (let i = 0; i < nPoints; i++) {
    const x = xMin + i * step;
    let y = 0;
    for (const f of freqs) {
      if (f.irIntensity <= 0) continue;
      const dx = x - f.wavenumber * scale;
      y += f.irIntensity * g2 / (dx * dx + g2);
    }
    result.push({ x, y });
  }

  return result;
}

export function computeFreqSpectrum(
  freqs: { wavenumber: number; irIntensity?: number }[],
  opts?: IRSpectrumOptions,
): { x: number; y: number }[] {
  const xMin = opts?.xMin ?? 0;
  const xMax = opts?.xMax ?? 4000;
  const gamma = opts?.halfWidth ?? 20;
  const nPoints = opts?.nPoints ?? 500;
  const scale = opts?.scaleFactor ?? 1.0;

  const real = freqs.filter((f) => f.wavenumber > 0);
  if (real.length === 0 || nPoints < 2) return [];

  const step = (xMax - xMin) / (nPoints - 1);
  const g2 = gamma * gamma;
  const result: { x: number; y: number }[] = [];

  for (let i = 0; i < nPoints; i++) {
    const x = xMin + i * step;
    let y = 0;
    for (const f of real) {
      const w = f.irIntensity != null && f.irIntensity > 0 ? f.irIntensity : 1;
      const dx = x - f.wavenumber * scale;
      y += w * g2 / (dx * dx + g2);
    }
    result.push({ x, y });
  }

  return result;
}

export const IR_SCALE_PRESETS: Record<string, number> = {
  "B3LYP/6-31G(d)": 0.9614,
  "B3LYP/6-31G(d,p)": 0.9614,
  "B3LYP/6-311+G(2d,p)": 0.9688,
  "B3LYP/cc-pVTZ": 0.9682,
  "B3LYP/def2-TZVPP": 0.9750,
  "B3LYP/def2-SVP": 0.9700,
  "wB97X-D3/def2-TZVPP": 0.9570,
  "PBE0/def2-TZVPP": 0.9512,
  "M06-2X/6-31+G(d,p)": 0.9489,
  "M06-2X/def2-TZVPP": 0.9530,
  "r2SCAN-3c": 0.9710,
  "B97-3c": 0.9700,
  "HF/6-31G(d)": 0.8929,
  "MP2/cc-pVTZ": 0.9523,
};

export function lookupScaleFactor(
  functional: string | undefined,
  basis: string | undefined,
): number | undefined {
  if (!functional) return undefined;
  const key = basis ? `${functional}/${basis}` : functional;
  return IR_SCALE_PRESETS[key];
}

export function hasIRData(
  freqs: { irIntensity?: number }[],
): boolean {
  return freqs.some((f) => f.irIntensity != null && f.irIntensity > 0);
}
