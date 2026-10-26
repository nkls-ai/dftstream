import type { Frequency } from "../data/types";

/** Frequencies of one run grouped by the hessian calculation they came
 *  from. Legacy rows (no hessIdx) yield an empty history whose `latest`
 *  is simply all rows — the pre-history behavior. */
export interface FrequencyHistory {
  /** Ascending hessian ordinals; empty for legacy data. */
  hessIndices: number[];
  byHess: Map<number, Frequency[]>;
  /** The newest hessian's modes (all rows for legacy data). */
  latest: Frequency[];
  latestHessIdx: number | null;
}

export function groupFrequenciesByHessian(
  rows: Frequency[] | undefined,
): FrequencyHistory {
  const byHess = new Map<number, Frequency[]>();
  const legacy: Frequency[] = [];
  for (const f of rows ?? []) {
    if (f.hessIdx == null) {
      legacy.push(f);
      continue;
    }
    const group = byHess.get(f.hessIdx);
    if (group) {
      group.push(f);
    } else {
      byHess.set(f.hessIdx, [f]);
    }
  }
  const hessIndices = [...byHess.keys()].sort((a, b) => a - b);
  for (const idx of hessIndices) {
    byHess.get(idx)!.sort((a, b) => a.idx - b.idx);
  }
  legacy.sort((a, b) => a.idx - b.idx);
  const latestHessIdx = hessIndices.at(-1) ?? null;
  return {
    hessIndices,
    byHess,
    latest: latestHessIdx != null ? byHess.get(latestHessIdx)! : legacy,
    latestHessIdx,
  };
}
