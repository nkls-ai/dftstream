// Energetics of a reaction: forward/reverse barriers and the reaction
// energy, in electronic and Gibbs terms, with optional high-level
// single-point refinement. Pure and React-free.

import type { Run } from "../data/types";
import { HARTREE_TO_KCAL } from "./constants";
import { gMinusElectronicEh } from "./thermo";

/** One stationary point's energies, after any SP refinement. */
export interface ProfilePoint {
  label: string;
  /** Electronic energy (Eh) — the SP value when one is linked. */
  eEh?: number;
  /** Gibbs energy (Eh). Composite when refined: E(SP) + (G − E)low. */
  gEh?: number;
  /** True when a high-level single point replaced the electronic energy. */
  refined: boolean;
}

export interface ReactionEnergetics {
  reactant?: ProfilePoint;
  ts?: ProfilePoint;
  product?: ProfilePoint;
  /** Forward barrier TS − reactant (kcal/mol). */
  barrierFwdKcal?: number;
  barrierRevKcal?: number;
  reactionKcal?: number;
  /** Same three quantities on the Gibbs surface. */
  barrierFwdGKcal?: number;
  barrierRevGKcal?: number;
  reactionGKcal?: number;
  /** Set when only some points carry an SP refinement. */
  mixedLevels: boolean;
}

/**
 * Builds one stationary point. When an SP run is supplied, its electronic
 * energy replaces the low-level one and the Gibbs energy becomes the
 * standard composite E(SP) + (G − E)low — the thermal correction always
 * comes from the level the frequencies were computed at.
 */
export function profilePoint(label: string, run: Run | undefined, sp?: Run): ProfilePoint | undefined {
  if (!run) return undefined;
  const eLow = run.lastEnergy;
  const gMinusE = gMinusElectronicEh(run);
  const eSp = sp?.lastEnergy;
  const eEh = eSp ?? eLow;
  const gEh = eEh != null && gMinusE != null ? eEh + gMinusE : run.gibbsEh;
  return { label, eEh, gEh, refined: eSp != null };
}

function diffKcal(a: number | undefined, b: number | undefined): number | undefined {
  return a != null && b != null ? (a - b) * HARTREE_TO_KCAL : undefined;
}

export function reactionEnergetics(points: {
  reactant?: ProfilePoint;
  ts?: ProfilePoint;
  product?: ProfilePoint;
}): ReactionEnergetics {
  const { reactant, ts, product } = points;
  const present = [reactant, ts, product].filter((p): p is ProfilePoint => p != null);
  const refinedCount = present.filter((p) => p.refined).length;
  return {
    reactant,
    ts,
    product,
    barrierFwdKcal: diffKcal(ts?.eEh, reactant?.eEh),
    barrierRevKcal: diffKcal(ts?.eEh, product?.eEh),
    reactionKcal: diffKcal(product?.eEh, reactant?.eEh),
    barrierFwdGKcal: diffKcal(ts?.gEh, reactant?.gEh),
    barrierRevGKcal: diffKcal(ts?.gEh, product?.gEh),
    reactionGKcal: diffKcal(product?.gEh, reactant?.gEh),
    mixedLevels: refinedCount > 0 && refinedCount < present.length,
  };
}
