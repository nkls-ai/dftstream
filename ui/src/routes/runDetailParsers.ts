import type { Run } from "../data/types";
import { HARTREE_TO_KCAL } from "../lib/constants";

export interface Thermo {
  electronicEh: number | null;
  zpeEh: number | null;
  zpeKcal: number | null;
  innerEh: number | null;
  enthalpyEh: number | null;
  entropyEh: number | null;
  entropyKcal: number | null;
  gibbsEh: number | null;
  gMinusEEh: number | null;
  gMinusEKcal: number | null;
  totalCorrEh: number | null;
  totalCorrKcal: number | null;
  // Conditions of the section ("THERMOCHEMISTRY AT 298.15K" header block).
  temperatureK: number | null;
  pressureAtm: number | null;
  quasiRRHO: boolean | null;
  // Inner-energy correction terms (U = E(el) + ZPE + vib + rot + trans).
  thermalVibCorrEh: number | null;
  thermalVibCorrKcal: number | null;
  thermalRotCorrEh: number | null;
  thermalRotCorrKcal: number | null;
  thermalTransCorrEh: number | null;
  thermalTransCorrKcal: number | null;
  totalThermalCorrEh: number | null;
  totalThermalCorrKcal: number | null;
  // Enthalpy correction (H = U + kB·T).
  enthalpyCorrEh: number | null;
  enthalpyCorrKcal: number | null;
  // Entropy terms, printed as T·S contributions.
  electronicEntropyEh: number | null;
  vibEntropyEh: number | null;
  rotEntropyEh: number | null;
  transEntropyEh: number | null;
  finalEntropyTermEh: number | null;
  finalEntropyTermKcal: number | null;
}

export interface OrbitalSummary {
  homo: number;
  lumo: number;
  gapEh: number;
  gapEv: number;
  homoMO: number;
  lumoMO: number;
}

export interface PartialCharge {
  idx: number;
  element: string;
  charge: number;
}

export interface BondOrder {
  atomA: number;
  elemA: string;
  atomB: number;
  elemB: string;
  order: number;
}

export interface OutProperties {
  orbitals: OrbitalSummary | null;
  /** Full MO energy table of the last ORBITAL ENERGIES section, for the
   *  energy-level diagram. Bounded (see parseOrbitalTable). */
  orbitalLevels: OrbitalLevel[] | null;
  npa: PartialCharge[] | null;
  mulliken: PartialCharge[] | null;
  loewdin: PartialCharge[] | null;
  bondOrders: BondOrder[] | null;
  dipoleDebye: number | null;
  /** Dipole vector in atomic units from the last "Total Dipole Moment"
   *  line, for the 3D viewer arrow overlay. */
  dipoleVecAU: [number, number, number] | null;
  /** Spin contamination from the last <S**2> block (UHF/UKS only). */
  spin: SpinContamination | null;
}

export interface SpinContamination {
  s2: number;
  s2Ideal: number;
}

export interface OrbitalLevel {
  idx: number;
  occ: number;
  eh: number;
  ev: number;
}

// mergeRunThermo combines the thermochemistry stored on the run record
// (parsed by the wrapper at run end — instantly available, works even
// when no .out artifact was captured) with the client-side parse of the
// .out (which adds fields the record doesn't carry, e.g. electronicEh).
// Parsed values win per-field once the artifact download finishes.
export function mergeRunThermo(
  run: Run | undefined,
  parsed: Thermo | null,
): Thermo | null {
  const hasRecord =
    run != null &&
    (run.zpeEh != null ||
      run.enthalpyEh != null ||
      run.entropyCorrEh != null ||
      run.gibbsEh != null ||
      run.gMinusEEh != null);
  if (!hasRecord) return parsed;
  const kcal = (v: number | undefined | null): number | null =>
    v != null ? v * HARTREE_TO_KCAL : null;
  const fromRun: Thermo = {
    ...EMPTY_THERMO,
    zpeEh: run.zpeEh ?? null,
    zpeKcal: kcal(run.zpeEh),
    enthalpyEh: run.enthalpyEh ?? null,
    entropyEh: run.entropyCorrEh ?? null,
    entropyKcal: kcal(run.entropyCorrEh),
    gibbsEh: run.gibbsEh ?? null,
    gMinusEEh: run.gMinusEEh ?? null,
    gMinusEKcal: kcal(run.gMinusEEh),
  };
  if (!parsed) return fromRun;
  const merged = { ...fromRun };
  const takeParsed = <K extends keyof Thermo>(key: K) => {
    if (parsed[key] != null) merged[key] = parsed[key];
  };
  for (const key of Object.keys(merged) as (keyof Thermo)[]) takeParsed(key);
  return merged;
}

export const EMPTY_THERMO: Thermo = {
  electronicEh: null,
  zpeEh: null,
  zpeKcal: null,
  innerEh: null,
  enthalpyEh: null,
  entropyEh: null,
  entropyKcal: null,
  gibbsEh: null,
  gMinusEEh: null,
  gMinusEKcal: null,
  totalCorrEh: null,
  totalCorrKcal: null,
  temperatureK: null,
  pressureAtm: null,
  quasiRRHO: null,
  thermalVibCorrEh: null,
  thermalVibCorrKcal: null,
  thermalRotCorrEh: null,
  thermalRotCorrKcal: null,
  thermalTransCorrEh: null,
  thermalTransCorrKcal: null,
  totalThermalCorrEh: null,
  totalThermalCorrKcal: null,
  enthalpyCorrEh: null,
  enthalpyCorrKcal: null,
  electronicEntropyEh: null,
  vibEntropyEh: null,
  rotEntropyEh: null,
  transEntropyEh: null,
  finalEntropyTermEh: null,
  finalEntropyTermKcal: null,
};

const THERMO_HEADER = "THERMOCHEMISTRY AT";
const OPT_CONVERGED_BANNER = "THE OPTIMIZATION HAS CONVERGED";
const OPT_CYCLE_BANNER = "GEOMETRY OPTIMIZATION CYCLE";

/**
 * Parses the LAST thermochemistry section of an ORCA output. Returns null
 * when the only section describes the *starting* geometry: `calc_hess`
 * prints a full frequency + thermochemistry block before the optimizer
 * runs, and showing that for an optimization would attach the wrong
 * energies to the final structure.
 */
export function parseThermo(text: string): Thermo | null {
  const sectionStart = text.lastIndexOf(THERMO_HEADER);
  if (sectionStart < 0) return null;
  // A section belongs to the final geometry when the run either never
  // entered a geometry optimization, or printed the section after the
  // optimizer's convergence banner.
  const isOptRun = text.lastIndexOf(OPT_CYCLE_BANNER) >= 0;
  const convergedIdx = text.lastIndexOf(OPT_CONVERGED_BANNER);
  const afterConvergence = convergedIdx >= 0 && convergedIdx < sectionStart;
  if (isOptRun && !afterConvergence) return null;
  const section = text.slice(sectionStart);

  const grabEh = (re: RegExp): number | null => {
    const m = section.match(re);
    return m && m[1] ? Number(m[1]) : null;
  };
  const grabEhKcal = (re: RegExp): [number | null, number | null] => {
    const m = section.match(re);
    if (!m) return [null, null];
    return [
      m[1] != null ? Number(m[1]) : null,
      m[2] != null ? Number(m[2]) : null,
    ];
  };
  const ehKcal = (label: string): [number | null, number | null] =>
    grabEhKcal(
      new RegExp(
        `${label}\\s*(?:\\.+\\s*)?(-?\\d+\\.\\d+)\\s*Eh\\s+(-?\\d+\\.\\d+)\\s*kcal\\/mol`,
        "i",
      ),
    );

  const [zpeEh, zpeKcal] = ehKcal("Zero point energy");
  const [entropyEh, entropyKcal] = ehKcal("Total entropy correction");
  const [gMinusEEh, gMinusEKcal] = ehKcal("G-E\\(el\\)");
  const [totalCorrEh, totalCorrKcal] = ehKcal("Total correction");
  const [thermalVibCorrEh, thermalVibCorrKcal] = ehKcal("Thermal vibrational correction");
  const [thermalRotCorrEh, thermalRotCorrKcal] = ehKcal("Thermal rotational correction");
  const [thermalTransCorrEh, thermalTransCorrKcal] = ehKcal("Thermal translational correction");
  const [totalThermalCorrEh, totalThermalCorrKcal] = ehKcal("Total thermal correction");
  const [enthalpyCorrEh, enthalpyCorrKcal] = ehKcal("Thermal Enthalpy correction");
  const [electronicEntropyEh] = ehKcal("Electronic entropy");
  const [vibEntropyEh] = ehKcal("Vibrational entropy");
  const [rotEntropyEh] = ehKcal("Rotational entropy");
  const [transEntropyEh] = ehKcal("Translational entropy");
  const [finalEntropyTermEh, finalEntropyTermKcal] = ehKcal("Final entropy term");

  const tempMatch = section.match(/Temperature\s*\.+\s*(\d+(?:\.\d+)?)\s*K/i);
  const pressMatch = section.match(/Pressure\s*\.+\s*(\d+(?:\.\d+)?)\s*atm/i);
  const qrrhoMatch = section.match(/Quasi RRHO\s*\.+\s*(True|False)/i);

  return {
    electronicEh: grabEh(/Electronic energy\s*\.+\s*(-?\d+\.\d+)\s*Eh/i),
    zpeEh,
    zpeKcal,
    innerEh: grabEh(/Total thermal energy\s+(-?\d+\.\d+)\s*Eh/i),
    enthalpyEh: grabEh(/Total enthalpy\s*\.+\s*(-?\d+\.\d+)\s*Eh/i),
    entropyEh,
    entropyKcal,
    gibbsEh: grabEh(/Final Gibbs free energy\s*\.+\s*(-?\d+\.\d+)\s*Eh/i),
    gMinusEEh,
    gMinusEKcal,
    totalCorrEh,
    totalCorrKcal,
    temperatureK: tempMatch && tempMatch[1] ? Number(tempMatch[1]) : null,
    pressureAtm: pressMatch && pressMatch[1] ? Number(pressMatch[1]) : null,
    quasiRRHO: qrrhoMatch ? /true/i.test(qrrhoMatch[1] ?? "") : null,
    thermalVibCorrEh,
    thermalVibCorrKcal,
    thermalRotCorrEh,
    thermalRotCorrKcal,
    thermalTransCorrEh,
    thermalTransCorrKcal,
    totalThermalCorrEh,
    totalThermalCorrKcal,
    enthalpyCorrEh,
    enthalpyCorrKcal,
    electronicEntropyEh,
    vibEntropyEh,
    rotEntropyEh,
    transEntropyEh,
    finalEntropyTermEh,
    finalEntropyTermKcal,
  };
}

export function parseOutProperties(text: string): OutProperties {
  return {
    orbitals: parseOrbitals(text),
    orbitalLevels: parseOrbitalTable(text),
    npa: parseNPACharges(text),
    mulliken: parseChargeBlock(text, "MULLIKEN ATOMIC CHARGES"),
    loewdin: parseChargeBlock(text, "LOEWDIN ATOMIC CHARGES"),
    bondOrders: parseMayerBondOrders(text),
    dipoleDebye: parseDipole(text),
    dipoleVecAU: parseDipoleVec(text),
    spin: parseSpinContamination(text),
  };
}

// Spin contamination of the FINAL SCF: like the other property parsers,
// anchored on the last occurrence. RKS runs print no <S**2> block.
function parseSpinContamination(text: string): SpinContamination | null {
  const idx = text.lastIndexOf("Expectation value of <S**2>");
  if (idx < 0) return null;
  const slice = text.slice(idx, idx + 400);
  const s2 = slice.match(/Expectation value of <S\*\*2>\s*:\s*(-?\d+\.\d+)/);
  const ideal = slice.match(/Ideal value S\*\(S\+1\) for S=\S+\s*:\s*(-?\d+\.\d+)/);
  if (!s2?.[1] || !ideal?.[1]) return null;
  return { s2: Number(s2[1]), s2Ideal: Number(ideal[1]) };
}

/** Parses the last ORBITAL ENERGIES table into MO levels. Bounded to
 *  4000 lines — large systems truncate rather than freeze the worker. */
function parseOrbitalTable(text: string): OrbitalLevel[] | null {
  const start = text.lastIndexOf("ORBITAL ENERGIES");
  if (start < 0) return null;
  const lines = text.slice(start).split("\n").slice(0, 4000);
  let inTable = false;
  const orbs: OrbitalLevel[] = [];
  for (const line of lines) {
    if (/^\s*NO\s+OCC\s+E\(Eh\)/i.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    const m = line.match(
      /^\s*(\d+)\s+([\d.]+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)/,
    );
    if (m) {
      orbs.push({
        idx: +m[1]!,
        occ: +m[2]!,
        eh: +m[3]!,
        ev: +m[4]!,
      });
    } else if (orbs.length > 0) {
      break;
    }
  }
  return orbs.length ? orbs : null;
}

function parseOrbitals(text: string): OrbitalSummary | null {
  const orbs = parseOrbitalTable(text);
  if (!orbs) return null;
  let homoIdx = -1;
  for (let i = 0; i < orbs.length; i++) {
    if ((orbs[i]!.occ) > 0.0) homoIdx = i;
    else break;
  }
  if (homoIdx < 0 || homoIdx + 1 >= orbs.length) return null;
  const homo = orbs[homoIdx]!;
  const lumo = orbs[homoIdx + 1]!;
  return {
    homo: homo.eh,
    lumo: lumo.eh,
    gapEh: lumo.eh - homo.eh,
    gapEv: lumo.ev - homo.ev,
    homoMO: homo.idx,
    lumoMO: lumo.idx,
  };
}

function parseChargeBlock(text: string, header: string): PartialCharge[] | null {
  const idx = text.lastIndexOf(header);
  if (idx < 0) return null;
  const lines = text.slice(idx).split("\n");
  const out: PartialCharge[] = [];
  for (let i = 1; i < lines.length && i < 500; i++) {
    const line = lines[i] ?? "";
    if (/Sum of atomic charges/i.test(line)) break;
    const m = line.match(/^\s*(\d+)\s+([A-Z][a-z]?)\s*:\s*(-?\d+\.\d+)/);
    if (m) {
      out.push({ idx: +m[1]!, element: m[2]!, charge: +m[3]! });
    } else if (out.length > 0 && line.trim() === "") {
      break;
    }
  }
  return out.length ? out : null;
}

function parseMayerBondOrders(text: string): BondOrder[] | null {
  const marker = "Mayer bond orders larger than";
  const idx = text.lastIndexOf(marker);
  if (idx < 0) return null;
  const lines = text.slice(idx).split("\n");
  const out: BondOrder[] = [];
  const re = /B\(\s*(\d+)-([A-Z][a-z]?)\s*,\s*(\d+)-([A-Z][a-z]?)\s*\)\s*:\s*(\d+\.\d+)/g;
  for (let i = 1; i < lines.length && i < 200; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      if (out.length > 0) break;
      continue;
    }
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(line)) !== null) {
      out.push({
        atomA: +m[1]!,
        elemA: m[2]!,
        atomB: +m[3]!,
        elemB: m[4]!,
        order: +m[5]!,
      });
    }
  }
  return out.length ? out.sort((a, b) => b.order - a.order) : null;
}

function parseNPACharges(text: string): PartialCharge[] | null {
  const marker = "Summary of Natural Population Analysis:";
  const idx = text.lastIndexOf(marker);
  if (idx < 0) return null;
  const lines = text.slice(idx).split("\n");
  const out: PartialCharge[] = [];
  for (let i = 1; i < lines.length && i < 500; i++) {
    const line = lines[i] ?? "";
    if (/^[= ]+$/.test(line.trim()) && out.length > 0) break;
    if (/^\s*\*\s*Total\s*\*/i.test(line)) break;
    const m = line.match(
      /^\s*([A-Z][a-z]?)\s+(\d+)\s+(-?\d+\.\d+)/,
    );
    if (m) {
      out.push({ idx: +m[2]!, element: m[1]!, charge: +m[3]! });
    }
  }
  return out.length ? out : null;
}

// Dipole of the FINAL geometry: an Opt prints one dipole block per cycle,
// so both parsers anchor on the last occurrence.
function parseDipole(text: string): number | null {
  const idx = text.lastIndexOf("Magnitude (Debye)");
  if (idx < 0) return null;
  const m = text.slice(idx).match(/Magnitude\s*\(Debye\)\s*:\s*(-?\d+\.\d+)/);
  return m ? Number(m[1]) : null;
}

function parseDipoleVec(text: string): [number, number, number] | null {
  const idx = text.lastIndexOf("Total Dipole Moment");
  if (idx < 0) return null;
  const m = text
    .slice(idx)
    .match(/Total Dipole Moment\s*:\s*(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function extractMOIndex(name: string): number | null {
  const m = name.match(/\.mo(\d+)[ab]\.cube$/i);
  return m ? Number(m[1]) : null;
}

export function extractCubeCycle(name: string): number | null {
  const m = name.match(/\.c(\d+)\.mo\d+[ab]\.cube$/i);
  return m ? Number(m[1]) : null;
}

export function extractVibModeIndex(name: string): number | null {
  const m = name.match(/\.v(\d+)\.xyz$/i);
  return m ? Number(m[1]) : null;
}

export function extractHessianIndex(name: string): string | null {
  const m = name.match(/\.h(\d+)\.v\d+\.xyz$/i);
  return m ? m[1]! : null;
}
