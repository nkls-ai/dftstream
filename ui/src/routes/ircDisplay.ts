import type { ChartAnnotation } from "../components/EnergyChart";
import { HARTREE_TO_KCAL } from "../lib/constants";
import type { IRCPathPoint, IRCSummary } from "./irc";

export function buildIRCChartData(path: IRCPathPoint[]): { x: number; y: number }[] {
  return path.map((p) => ({ x: p.pathIndex, y: p.relativeKcal }));
}

export function buildIRCAnnotations(path: IRCPathPoint[]): ChartAnnotation[] {
  const a: ChartAnnotation[] = [];
  const ts = path.find((p) => p.pathIndex === 0);
  if (ts) a.push({ x: 0, y: ts.relativeKcal, label: "TS", hue: "gold" });
  if (path.length > 0) {
    a.push({ x: path[0]!.pathIndex, y: path[0]!.relativeKcal, label: "R", hue: "teal" });
    const last = path[path.length - 1]!;
    a.push({ x: last.pathIndex, y: last.relativeKcal, label: "P", hue: "violet" });
  }
  return a;
}

export function ircEndpointDeltasKcal(summary: IRCSummary): {
  fwdDeltaKcal: number | null;
  bwdDeltaKcal: number | null;
} {
  const fwdEnd = summary.forward[summary.forward.length - 1];
  const bwdEnd = summary.backward[summary.backward.length - 1];
  const tsE = summary.tsEnergy ?? 0;
  const fwdDeltaKcal = fwdEnd ? (fwdEnd.energy - tsE) * HARTREE_TO_KCAL : null;
  const bwdDeltaKcal = bwdEnd ? (bwdEnd.energy - tsE) * HARTREE_TO_KCAL : null;
  return { fwdDeltaKcal, bwdDeltaKcal };
}

export function ircStepLabel(i: number, path: IRCPathPoint[], tsIdx: number): string {
  if (i === 0) return "Reactant";
  if (i === tsIdx) return "TS";
  if (i === path.length - 1) return "Product";
  const p = path[i];
  return p ? `step ${p.pathIndex}` : `${i + 1} / ${path.length}`;
}
