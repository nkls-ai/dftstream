// Pure derivations for the transition-state tab. React-free so they can be
// unit tested directly.

import type { VibBlob } from "../data/DataSource";
import type { MetricPoint } from "../data/types";
import { lookupScaleFactor } from "../lib/irSpectrum";
import { extractHessianIndex, extractVibModeIndex, type Thermo } from "./runDetailParsers";

export interface VibModeGroups {
  /** Mode index -> displacement xyz for the final hessian. */
  final: Map<number, string>;
  /** Hessian index -> (mode index -> displacement xyz) for intermediates. */
  byHess: Map<string, Map<number, string>>;
}

// Separate final hessian vibs from intermediate hessian vibs.
export function groupVibModes(vibs: VibBlob[] | undefined): {
  vibByMode: VibModeGroups;
  hessianOptions: string[];
} {
  const final = new Map<number, string>();
  const byHess = new Map<string, Map<number, string>>();
  for (const v of vibs ?? []) {
    const mode = extractVibModeIndex(v.name);
    if (mode == null) continue;
    const hIdx = extractHessianIndex(v.name);
    if (hIdx == null) {
      final.set(mode, v.contentText);
    } else {
      if (!byHess.has(hIdx)) byHess.set(hIdx, new Map());
      byHess.get(hIdx)!.set(mode, v.contentText);
    }
  }
  const options = ["final", ...Array.from(byHess.keys()).sort()];
  return { vibByMode: { final, byHess }, hessianOptions: options };
}

// Per-cycle energy series: the last value seen for a cycle wins, sorted by
// cycle number.
export function buildCycleEnergySeries(points: MetricPoint[] | undefined): { x: number; y: number }[] {
  const byKey = new Map<number, number>();
  for (const p of points ?? []) {
    byKey.set(p.cycle ?? 0, p.value);
  }
  return [...byKey.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([x, y]) => ({ x, y }));
}

// %geom Calc_Hess/Recalc_Hess makes the optimizer print frequencies from
// recalculated (approximate) hessians; without an explicit Freq keyword
// there is no exact final hessian to trust.
export function usesRecalcHess(inputText: string | undefined): boolean {
  return /(?:^|\s)(?:re)?calc_hess\s+(?:true|\d+)/im.test(inputText ?? "");
}

// User-configured scale factors win over the built-in presets; the exact
// functional/basis pair wins over a functional-only entry.
export function resolveIrScale(
  irScaleFactors: Record<string, number>,
  functional: string | undefined,
  basis: string | undefined,
): number | undefined {
  return irScaleFactors[`${functional}/${basis}`]
    ?? irScaleFactors[functional ?? ""]
    ?? lookupScaleFactor(functional, basis);
}

export function hasThermoData(thermo: Thermo | null): thermo is Thermo {
  return thermo != null && (thermo.zpeEh != null || thermo.enthalpyEh != null || thermo.gibbsEh != null);
}
