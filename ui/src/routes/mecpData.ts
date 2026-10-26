// Pure derivations for the MECP tab: merging the two-state energy/gap metric
// streams into per-cycle points and building the chart series. React-free so
// they can be unit tested directly.

import type { MetricPoint } from "../data/types";
import { HARTREE_TO_KCAL } from "../lib/constants";

export interface MECPPoint {
  cycle: number;
  state1Energy?: number;
  state2Energy?: number;
  gapEh?: number;
}

export function buildMecpPoints(
  state1: MetricPoint[] | undefined,
  state2: MetricPoint[] | undefined,
  gaps: MetricPoint[] | undefined,
): MECPPoint[] {
  const byCycle = new Map<number, MECPPoint>();
  const get = (cycle: number) => {
    const existing = byCycle.get(cycle);
    if (existing) return existing;
    const created: MECPPoint = { cycle };
    byCycle.set(cycle, created);
    return created;
  };
  for (const p of state1 ?? []) get(p.cycle ?? 0).state1Energy = p.value;
  for (const p of state2 ?? []) get(p.cycle ?? 0).state2Energy = p.value;
  for (const p of gaps ?? []) get(p.cycle ?? 0).gapEh = p.value;
  return [...byCycle.values()].sort((a, b) => a.cycle - b.cycle);
}

export function buildGapSeries(points: MECPPoint[]): { x: number; y: number }[] {
  return points
    .filter((p) => p.gapEh != null)
    .map((p) => ({ x: p.cycle, y: (p.gapEh ?? 0) * HARTREE_TO_KCAL }));
}

export interface MECPEnergyRow {
  cycle: number;
  state1: number | null;
  state2: number | null;
}

export function buildRelativeEnergySeries(points: MECPPoint[]): MECPEnergyRow[] {
  const energies = points.flatMap((p) => [p.state1Energy, p.state2Energy])
    .filter((v): v is number => v != null);
  // No state energies parsed (only gaps): leave the relative energies null
  // rather than subtracting Math.min([]) === Infinity, which would turn every
  // value into NaN. reduce() also avoids a spread-arg stack blowout on big sets.
  if (energies.length === 0) {
    return points.map((p) => ({ cycle: p.cycle, state1: null, state2: null }));
  }
  const ref = energies.reduce((m, v) => Math.min(m, v), Infinity);
  return points.map((p) => ({
    cycle: p.cycle,
    state1: p.state1Energy != null ? (p.state1Energy - ref) * HARTREE_TO_KCAL : null,
    state2: p.state2Energy != null ? (p.state2Energy - ref) * HARTREE_TO_KCAL : null,
  }));
}

export interface MECPFinalStats {
  finalGapKcal: number | null;
  /** Average of the two surfaces, or whichever state energy is present. */
  finalEnergy: number | null;
}

export function mecpFinalStats(points: MECPPoint[]): MECPFinalStats {
  const finalPoint = points[points.length - 1] ?? null;
  const finalGapKcal = finalPoint?.gapEh != null ? finalPoint.gapEh * HARTREE_TO_KCAL : null;
  const finalEnergy = finalPoint?.state1Energy != null && finalPoint.state2Energy != null
    ? (finalPoint.state1Energy + finalPoint.state2Energy) / 2
    : finalPoint?.state1Energy ?? finalPoint?.state2Energy ?? null;
  return { finalGapKcal, finalEnergy };
}
