import type { MetricPoint } from "../data/types";

export interface ScfSeriesPoint {
  x: number;
  y: number;
}

export interface ScfSeriesStats {
  lastE: number | null;
  dE: number | null;
  span: number | null;
}

/**
 * One SCF solve. ORCA can run more than one SCF under the same optimization
 * cycle — the "FINAL ENERGY EVALUATION AT THE STATIONARY POINT" after an Opt
 * re-solves the SCF and the wrapper files it under the last cycle — and each
 * solve restarts its iteration count at 1. Plotting both on one iteration
 * axis draws vertical jumps between unrelated points; merging or keeping the
 * last value per iteration would invent a convergence history that never
 * happened. So every solve is its own pass.
 */
export interface ScfPass {
  cycle: number;
  /** 1-based index of this SCF solve within its cycle. */
  pass: number;
  /** Number of SCF solves recorded for this cycle. */
  passCount: number;
  series: ScfSeriesPoint[];
}

/**
 * Splits scf_iter_energy points into SCF passes, ordered by cycle then pass.
 * Points are taken in arrival order (timestamp, ties kept stable); a pass
 * ends when an iteration number repeats within it.
 */
export function scfPasses(points: MetricPoint[] | undefined): ScfPass[] {
  const byCycle = new Map<number, MetricPoint[][]>();
  const ordered = [...(points ?? [])].sort((a, b) => a.ts - b.ts);
  const seen = new Map<number, Set<number>>();
  for (const p of ordered) {
    const cycle = p.cycle ?? 0;
    const iter = p.iter ?? 0;
    const passes = byCycle.get(cycle) ?? [];
    if (!byCycle.has(cycle)) byCycle.set(cycle, passes);
    let iters = seen.get(cycle);
    if (!iters || iters.has(iter)) {
      iters = new Set();
      seen.set(cycle, iters);
      passes.push([]);
    }
    iters.add(iter);
    passes[passes.length - 1]!.push(p);
  }
  return [...byCycle.entries()]
    .sort((a, b) => a[0] - b[0])
    .flatMap(([cycle, passes]) =>
      passes.map((pts, i) => ({
        cycle,
        pass: i + 1,
        passCount: passes.length,
        series: pts
          .sort((a, b) => (a.iter ?? 0) - (b.iter ?? 0))
          .map((p) => ({ x: p.iter ?? 0, y: p.value })),
      })),
    );
}

/** "cycle 9", or "cycle 9 · SCF 2/2" when the cycle holds several solves. */
export function scfPassLabel(pass: Pick<ScfPass, "cycle" | "pass" | "passCount">): string {
  return pass.passCount > 1
    ? `cycle ${pass.cycle} · SCF ${pass.pass}/${pass.passCount}`
    : `cycle ${pass.cycle}`;
}

export function scfSeriesStats(data: ScfSeriesPoint[]): ScfSeriesStats {
  const lastE = data.length ? data[data.length - 1]!.y : null;
  const prevE = data.length > 1 ? data[data.length - 2]!.y : null;
  const dE = lastE != null && prevE != null ? lastE - prevE : null;
  const firstE = data.length ? data[0]!.y : null;
  const span = lastE != null && firstE != null ? Math.abs(lastE - firstE) : null;
  return { lastE, dE, span };
}

export function scfDeltaTone(dE: number | null): "ok" | "warn" | undefined {
  if (dE != null && Math.abs(dE) < 1e-6) return "ok";
  if (dE != null && Math.abs(dE) < 1e-4) return "warn";
  return undefined;
}
