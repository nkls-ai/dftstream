export interface ExcitedStateData {
  idx: number;
  energyEv: number;
  wavelengthNm: number;
  oscStrength: number;
  transitions?: string;
}

/** Photon energy ↔ wavelength: E(eV) = EV_NM / λ(nm). */
const EV_NM = 1239.841984;

export interface UVVisSpectrumOptions {
  xMin?: number;
  xMax?: number;
  /** Gaussian FWHM in **eV** (broadening is physical in energy space). */
  fwhm?: number;
  nPoints?: number;
}

export function computeUVVisSpectrum(
  states: ExcitedStateData[],
  opts?: UVVisSpectrumOptions,
): { x: number; y: number }[] {
  const xMin = opts?.xMin ?? 150;
  const xMax = opts?.xMax ?? 700;
  // FWHM in eV. Electronic transitions are broadened in energy, not in
  // wavelength: λ = 1240/E is nonlinear, so a fixed-nm Gaussian wrongly gives
  // every band the same nm width and distorts shapes/heights toward the blue.
  const fwhm = opts?.fwhm ?? 0.4;
  const nPoints = opts?.nPoints ?? 500;

  const active = states.filter(
    (s) => s.oscStrength > 0 && s.wavelengthNm > 0 && s.energyEv > 0,
  );
  if (active.length === 0 || nPoints < 2) return [];

  const sigma = fwhm / (2 * Math.sqrt(2 * Math.log(2)));
  const norm = 1 / (sigma * Math.sqrt(2 * Math.PI));
  const step = (xMax - xMin) / (nPoints - 1);
  const result: { x: number; y: number }[] = [];

  for (let i = 0; i < nPoints; i++) {
    const x = xMin + i * step; // wavelength (nm)
    const ex = x > 0 ? EV_NM / x : 0; // energy at this grid wavelength (eV)
    let y = 0;
    for (const s of active) {
      const d = ex - s.energyEv;
      y += s.oscStrength * norm * Math.exp(-(d * d) / (2 * sigma * sigma));
    }
    result.push({ x, y });
  }

  return result;
}

export interface ParsedTransition {
  from: string;
  to: string;
  coeff: number;
  pct: number;
}

export function parseTransitions(json: string | undefined): ParsedTransition[] {
  if (!json) return [];
  try {
    const arr: { from: string; to: string; coeff: number }[] = JSON.parse(json);
    return arr.map((t) => ({
      ...t,
      // Guard against a missing/NaN coeff in otherwise-valid JSON, which would
      // render as "NaN%".
      pct: Number.isFinite(t.coeff) ? Math.round(t.coeff * t.coeff * 100) : 0,
    }));
  } catch {
    // malformed transition JSON — treat as no transitions
    return [];
  }
}
