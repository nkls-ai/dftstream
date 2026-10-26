import { parseMultiXYZ, parseXYZFrameEnergy } from "../components/xyz";

export interface GoatIteration {
  iter: number;
  minEnergyEh: number;
  sconfCalMolK: number;
  gconfKcalMol: number;
}

export interface GoatConformer {
  index: number;
  relativeEnergyKcalMol?: number;
  degeneracy?: number;
  percentTotal?: number;
  percentCumulative?: number;
  absoluteEnergyEh?: number;
  xyz?: string;
}

export interface GoatSummary {
  version?: string;
  minGlobalSteps?: number;
  finalWorkers?: number;
  ensembleTemperatureK?: number;
  conformersBelow3Kcal?: number;
  lowestEnergyEh?: number;
  sconfCalMolK?: number;
  gconfKcalMol?: number;
  iterations: GoatIteration[];
  conformers: GoatConformer[];
}

import { HARTREE_TO_KCAL } from "../lib/constants";

export function parseGoatOutput(text: string): GoatSummary | null {
  if (!/\bGOAT\b|# Final ensemble info #|A Global Optimizer Algorithm/i.test(text)) {
    return null;
  }

  const lines = text.split("\n");
  const summary: GoatSummary = { iterations: [], conformers: [] };
  const iterations = new Map<number, GoatIteration>();
  let inFinalEnsemble = false;
  // Iteration rows only count inside a "GOAT Global Iter N" table: the same
  // "int float float float" shape also matches every MO-energy row
  // (index, occupation, E(Eh), E(eV)) of the per-worker output echoed above.
  let inIterTable = false;

  for (const line of lines) {
    const param = parseGoatParam(line);
    if (param) {
      switch (param.label) {
        case "GOAT version":
          summary.version = param.value;
          break;
        case "Minimum global steps":
          summary.minGlobalSteps = parseNumber(param.value);
          break;
        case "Final number of workers":
          summary.finalWorkers = parseNumber(param.value);
          break;
        case "Ensemble temperature":
          summary.ensembleTemperatureK = parseNumber(param.value);
          break;
      }
    }

    if (line.includes("# Final ensemble info #")) {
      inFinalEnsemble = true;
      continue;
    }
    if (inFinalEnsemble) {
      const row = line.match(/^\s*(\d+)\s+(-?\d+(?:\.\d+)?)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/);
      if (row) {
        summary.conformers.push({
          index: Number(row[1]),
          relativeEnergyKcalMol: Number(row[2]),
          degeneracy: Number(row[3]),
          percentTotal: Number(row[4]),
          percentCumulative: Number(row[5]),
        });
        continue;
      }
      if (/^-{3,}/.test(line.trim()) || /Conformer\s+Energy/.test(line) || /^\s*\(kcal\/mol\)/.test(line)) {
        continue;
      }
    }

    if (/GOAT Global Iter\s+\d+/.test(line)) {
      inIterTable = true;
      continue;
    }
    const iter = inIterTable
      ? line.match(/^\s*(\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s*$/)
      : null;
    if (inIterTable && !iter && line.trim() !== "" && !isGoatIterHeader(line)) {
      inIterTable = false;
    }
    if (iter) {
      const point = {
        iter: Number(iter[1]),
        minEnergyEh: Number(iter[2]),
        sconfCalMolK: Number(iter[3]),
        gconfKcalMol: Number(iter[4]),
      };
      iterations.set(point.iter, point);
      continue;
    }

    const below = line.match(/Conformers below 3 kcal\/mol:\s*(\d+)/);
    if (below) summary.conformersBelow3Kcal = Number(below[1]);

    const lowest = line.match(/Lowest energy conformer\s*:\s*(-?\d+\.\d+)\s*Eh/);
    if (lowest) summary.lowestEnergyEh = Number(lowest[1]);

    const sconf = line.match(/Sconf at\s+[-\d.]+\s+K\s*:\s*(-?\d+\.\d+)\s*cal\/\(molK\)/);
    if (sconf) summary.sconfCalMolK = Number(sconf[1]);

    const gconf = line.match(/Gconf at\s+[-\d.]+\s+K\s*:\s*(-?\d+\.\d+)\s*kcal\/mol/);
    if (gconf) summary.gconfKcalMol = Number(gconf[1]);
  }

  summary.iterations = [...iterations.values()].sort((a, b) => a.iter - b.iter);
  return summary;
}

/** Column header / unit / rule lines of a "GOAT Global Iter" table. */
function isGoatIterHeader(line: string): boolean {
  return /^\s*Iter\s+Min En/.test(line) || /^\s*Hartree\b/.test(line) || /^\s*=+\s*$/.test(line);
}

export function mergeGoatConformerXYZ(
  summary: GoatSummary | null,
  xyzText: string | undefined,
): GoatConformer[] {
  const frames = xyzText ? parseMultiXYZ(xyzText) : [];
  const conformers: GoatConformer[] = summary?.conformers.length
    ? summary.conformers.map((c) => ({ ...c }))
    : frames.map((_, index) => ({ index }));
  const minEnergy = summary?.lowestEnergyEh ?? parseXYZFrameEnergy(frames[0]);

  for (let i = 0; i < frames.length; i++) {
    const target = conformers[i] ?? { index: i };
    target.xyz = frames[i];
    target.absoluteEnergyEh = parseXYZFrameEnergy(frames[i]);
    if (target.relativeEnergyKcalMol === undefined && target.absoluteEnergyEh !== undefined && minEnergy !== undefined) {
      target.relativeEnergyKcalMol = (target.absoluteEnergyEh - minEnergy) * HARTREE_TO_KCAL;
    }
    conformers[i] = target;
  }

  return conformers;
}

// Boltzmann constant in kcal/(mol·K).
const KB_KCAL = 0.0019872041;

// withBoltzmannPopulations fills percentTotal/percentCumulative from the
// conformer energies when ORCA's own "# Final ensemble info #" table was
// not present (e.g. output artifact missing, or older GOAT versions).
// Weights ∝ degeneracy · exp(−ΔE / kT); energies referenced to the
// minimum first for numerical stability. Existing ORCA-reported values
// are never overwritten.
export function withBoltzmannPopulations(
  conformers: GoatConformer[],
  temperatureK = 298.15,
): GoatConformer[] {
  if (conformers.some((c) => c.percentTotal != null)) return conformers;
  const rel = conformers.map((c) => {
    if (c.relativeEnergyKcalMol != null) return c.relativeEnergyKcalMol;
    return null;
  });
  const finite = rel.filter((x): x is number => x != null);
  if (finite.length === 0) return conformers;
  const min = Math.min(...finite);
  const weights = conformers.map((c, i) =>
    rel[i] == null
      ? 0
      : (c.degeneracy ?? 1) * Math.exp(-(rel[i]! - min) / (KB_KCAL * temperatureK)),
  );
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return conformers;
  let cumulative = 0;
  return conformers.map((c, i) => {
    const pct = (weights[i]! / total) * 100;
    cumulative += pct;
    return { ...c, percentTotal: pct, percentCumulative: cumulative };
  });
}

export const GOAT_EXPORT_COLUMNS = [
  "conformer",
  "energy_eh",
  "rel_kcal",
  "degeneracy",
  "pop_percent",
  "cumulative_percent",
] as const;

// Fixed precision and kcal/mol on purpose: a CSV is a data export with a
// stable schema (column names carry the unit), not a display honouring settings.
export function goatEnsembleCSV(conformers: GoatConformer[]): string {
  const lines: string[] = [GOAT_EXPORT_COLUMNS.join(",")];
  for (const c of conformers) {
    lines.push(
      [
        String(c.index),
        c.absoluteEnergyEh != null ? c.absoluteEnergyEh.toFixed(8) : "",
        c.relativeEnergyKcalMol != null ? c.relativeEnergyKcalMol.toFixed(3) : "",
        c.degeneracy != null ? String(c.degeneracy) : "",
        c.percentTotal != null ? c.percentTotal.toFixed(2) : "",
        c.percentCumulative != null ? c.percentCumulative.toFixed(2) : "",
      ].join(","),
    );
  }
  return lines.join("\n");
}

function parseGoatParam(line: string): { label: string; value: string } | null {
  const m = line.match(/^\s*([^.:]+?)\s+\.\.\.\s+(.+?)\s*$/);
  if (!m) return null;
  return { label: m[1]!.trim(), value: m[2]!.trim() };
}

function parseNumber(value: string): number | undefined {
  const m = value.match(/-?\d+(?:\.\d+)?/);
  if (!m) return undefined;
  return Number(m[0]);
}

