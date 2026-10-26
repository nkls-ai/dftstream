import type { Run } from "../data/types";
import { EH_TO_KCAL } from "./constants";

export interface MethodGroup {
  key: string;
  functional: string;
  basis: string;
  runs: Run[];
  bestEnergy: number;
  relKcal: number;
}

export function groupRunsByMethod(
  runs: Run[],
  referenceEnergy?: number,
): MethodGroup[] {
  const eligible = runs.filter(
    (r) => r.status === "finished" && r.lastEnergy != null,
  );
  if (eligible.length === 0) return [];

  const map = new Map<string, Run[]>();
  for (const r of eligible) {
    const func = r.functional ?? r.method ?? "unknown";
    const bas = r.basis ?? "—";
    const key = `${func} / ${bas}`;
    const arr = map.get(key) ?? [];
    arr.push(r);
    map.set(key, arr);
  }

  const ref =
    referenceEnergy ??
    Math.min(...eligible.map((r) => r.lastEnergy!));

  const groups: MethodGroup[] = [];
  for (const [key, groupRuns] of map) {
    const best = Math.min(...groupRuns.map((r) => r.lastEnergy!));
    groups.push({
      key,
      functional: groupRuns[0]!.functional ?? groupRuns[0]!.method ?? "unknown",
      basis: groupRuns[0]!.basis ?? "—",
      runs: groupRuns,
      bestEnergy: best,
      relKcal: (best - ref) * EH_TO_KCAL,
    });
  }

  groups.sort((a, b) => a.relKcal - b.relKcal);
  return groups;
}

export function methodFamily(run: Run): string {
  const m = run.method?.toLowerCase() ?? "";
  if (m.includes("xtb") || m.includes("tight-binding")) return "xtb";
  if (m === "hf") return "hf";
  if (m.includes("mp2") || m.includes("ccsd") || m.includes("dlpno")) return "wft";
  return "dft";
}
