import type { PointRole } from "../data/types";
import { EH_TO_KCAL } from "./constants";
import { molecularFormula, parseStructureText } from "./inputBuilder/xyz";
import { StructureSource } from "./inputBuilder/types";

/** Which thermochemical quantity the pathway profile plots. */
export type EnergyBasis = "E" | "H" | "G";

export const ENERGY_BASIS_LABEL: Record<EnergyBasis, string> = {
  E: "ΔE",
  H: "ΔH",
  G: "ΔG",
};

/** Pick the absolute energy (Eh) for a run under the given basis.
 *  H and G come from the thermochemistry block, so they exist only for
 *  runs that computed frequencies. */
export function basisEnergyEh(
  run: { lastEnergy?: number; enthalpyEh?: number; gibbsEh?: number } | undefined,
  basis: EnergyBasis,
): number | undefined {
  if (!run) return undefined;
  switch (basis) {
    case "E":
      return run.lastEnergy;
    case "H":
      return run.enthalpyEh;
    case "G":
      return run.gibbsEh;
  }
}

export function computeRelativeEnergies(energiesEh: number[]): number[] {
  if (energiesEh.length === 0) return [];
  const min = Math.min(...energiesEh);
  return energiesEh.map((e) => (e - min) * EH_TO_KCAL);
}

export function computeBarrierHeight(
  relKcal: number[],
  roles: PointRole[],
): { forward: number | null; reverse: number | null } | null {
  const firstReactant = relKcal.find((_, i) => roles[i] === "reactant");
  let lastProduct: number | undefined;
  for (let i = roles.length - 1; i >= 0; i--) {
    if (roles[i] === "product") { lastProduct = relKcal[i]; break; }
  }
  const tsEnergies = relKcal.filter((_, i) => roles[i] === "ts");
  if (tsEnergies.length === 0) return null;
  const maxTS = Math.max(...tsEnergies);
  // A missing reactant/product makes that barrier undefined — report null
  // rather than measuring against 0 kcal/mol (the global min), which would
  // silently display the absolute TS height as if it were the barrier.
  return {
    forward: firstReactant != null ? maxTS - firstReactant : null,
    reverse: lastProduct != null ? maxTS - lastProduct : null,
  };
}

export function computeReactionEnergy(
  relKcal: number[],
  roles: PointRole[],
): number | null {
  let reactantE: number | null = null;
  let productE: number | null = null;
  for (let i = 0; i < roles.length; i++) {
    if (roles[i] === "reactant" && reactantE === null) reactantE = relKcal[i]!;
    if (roles[i] === "product") productE = relKcal[i]!;
  }
  if (reactantE === null || productE === null) return null;
  return productE - reactantE;
}

export interface ProfilePoint {
  x: number;
  y: number;
  isStationary?: boolean;
  label?: string;
  role?: PointRole;
  runId?: string;
}

export function interpolateProfile(
  stationary: { x: number; y: number; label?: string; role?: PointRole; runId?: string }[],
  density = 20,
): ProfilePoint[] {
  if (stationary.length < 2) {
    return stationary.map((p) => ({ ...p, isStationary: true }));
  }

  const n = stationary.length;
  const xs = stationary.map((p) => p.x);
  const ys = stationary.map((p) => p.y);

  const h: number[] = [];
  const delta: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(xs[i + 1]! - xs[i]!);
    delta.push((ys[i + 1]! - ys[i]!) / h[i]!);
  }

  // Natural cubic spline: solve tridiagonal system for second derivatives
  const m = new Array(n).fill(0);
  if (n > 2) {
    const a: number[] = [];
    const b: number[] = [];
    const c: number[] = [];
    const d: number[] = [];
    for (let i = 1; i < n - 1; i++) {
      a.push(h[i - 1]!);
      b.push(2 * (h[i - 1]! + h[i]!));
      c.push(h[i]!);
      d.push(6 * (delta[i]! - delta[i - 1]!));
    }
    // Thomas algorithm
    const nn = b.length;
    for (let i = 1; i < nn; i++) {
      const w = a[i]! / b[i - 1]!;
      b[i]! -= w * c[i - 1]!;
      d[i]! -= w * d[i - 1]!;
    }
    m[nn] = d[nn - 1]! / b[nn - 1]!;
    for (let i = nn - 2; i >= 0; i--) {
      m[i + 1] = (d[i]! - c[i]! * m[i + 2]) / b[i]!;
    }
  }

  const result: ProfilePoint[] = [];
  for (let seg = 0; seg < n - 1; seg++) {
    const x0 = xs[seg]!;
    const x1 = xs[seg + 1]!;
    const y0 = ys[seg]!;
    const y1 = ys[seg + 1]!;
    const hh = h[seg]!;
    const m0 = m[seg];
    const m1 = m[seg + 1];

    for (let j = 0; j <= density; j++) {
      if (seg > 0 && j === 0) continue; // avoid duplicate at segment boundary
      const t = j / density;
      const x = x0 + t * hh;
      const a1 = (x1 - x) / hh;
      const a2 = (x - x0) / hh;
      const y =
        a1 * y0 +
        a2 * y1 +
        ((a1 * a1 * a1 - a1) * m0 + (a2 * a2 * a2 - a2) * m1) *
          (hh * hh) /
          6;

      const isStationary = j === 0 || j === density;
      const sp = isStationary
        ? stationary[j === 0 ? seg : seg + 1]
        : undefined;

      result.push({
        x,
        y,
        isStationary: isStationary || undefined,
        label: sp?.label,
        role: sp?.role,
        runId: sp?.runId,
      });
    }
  }

  return result;
}

// ---- Consistency ------------------------------------------------------------
// Relative energies between stationary points only mean something when every
// point is the same system: the same atoms, just rearranged. A pathway that
// mixes, say, a 3-atom isomer with an 18-atom molecule yields "barriers" of
// millions of kcal/mol. Detect that and refuse to present the numbers.

/** Beyond this spread no single-system reaction profile is plausible. */
export const MAX_PLAUSIBLE_SPAN_KCAL = 300;

export enum PathwayIssueKind {
  /** Points have different molecular formulas. */
  Composition = "composition",
  /** The energy spread is implausibly large (formulas unknown, or points
   *  at different levels of theory). */
  Magnitude = "magnitude",
}

export interface PathwayIssue {
  kind: PathwayIssueKind;
  message: string;
}

/** Hill formula of the atoms in an .xyz block; null if it holds no atoms. */
export function xyzFormula(xyz: string | undefined): string | null {
  if (!xyz) return null;
  const parsed = parseStructureText(xyz, StructureSource.Run);
  return parsed.structure ? molecularFormula(parsed.structure.atoms) : null;
}

/**
 * Checks that a pathway's points describe one chemical system.
 * `formula` is the point's molecular formula, or null/undefined when its
 * geometry is not (yet) known; `relKcal` are the points' relative energies.
 */
export function checkPathwayConsistency(
  points: readonly { name: string; formula: string | null | undefined }[],
  relKcal: readonly number[],
): PathwayIssue | null {
  const known = points.filter((p): p is { name: string; formula: string } => !!p.formula);
  const formulas = [...new Set(known.map((p) => p.formula))];
  if (formulas.length > 1) {
    const listing = known.map((p) => `${p.name}: ${p.formula}`).join(", ");
    return {
      kind: PathwayIssueKind.Composition,
      message: `The stationary points are different molecules (${listing}). Energy differences between them are not barriers or reaction energies.`,
    };
  }
  // Also catches same-formula points computed at different levels of theory,
  // whose absolute energies are not comparable either.
  if (relKcal.length > 0) {
    const span = Math.max(...relKcal) - Math.min(...relKcal);
    if (span > MAX_PLAUSIBLE_SPAN_KCAL) {
      return {
        kind: PathwayIssueKind.Magnitude,
        message: `The energies span ${span.toFixed(0)} kcal/mol, far more than any single reaction step. The points are probably not the same system (or not at the same level of theory).`,
      };
    }
  }
  return null;
}
