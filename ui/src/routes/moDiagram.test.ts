import { describe, expect, test } from "bun:test";
import type { OrbitalLevel } from "./runDetailParsers";
import { buildLevelGroups } from "./RunStructureMODiagram";

function lvl(idx: number, occ: number, eh: number): OrbitalLevel {
  return { idx, occ, eh, ev: eh * 27.2114 };
}

describe("buildLevelGroups", () => {
  test("windows around the frontier and finds HOMO/LUMO", () => {
    const levels = [
      ...Array.from({ length: 30 }, (_, i) => lvl(i, 2, -10 + i * 0.3)),
      ...Array.from({ length: 30 }, (_, i) => lvl(30 + i, 0, 0.1 + i * 0.3)),
    ];
    const { groups, homoMO, lumoMO } = buildLevelGroups(levels);
    expect(homoMO).toBe(29);
    expect(lumoMO).toBe(30);
    // 10 occupied + 10 virtual, no degeneracy in this ladder
    expect(groups.length).toBe(20);
    expect(groups.filter((g) => g.occupied).length).toBe(10);
  });

  test("groups near-degenerate levels", () => {
    const levels = [
      lvl(0, 2, -1.0),
      lvl(1, 2, -0.5),
      lvl(2, 2, -0.4999), // degenerate with MO 1
      lvl(3, 0, 0.1),
    ];
    const { groups } = buildLevelGroups(levels);
    const degenerate = groups.find((g) => g.levels.length === 2);
    expect(degenerate).toBeDefined();
    expect(degenerate!.levels.map((l) => l.idx)).toEqual([1, 2]);
  });

  test("does not merge occupied with virtual even when close", () => {
    const levels = [lvl(0, 2, -0.001), lvl(1, 0, 0.0)];
    const { groups } = buildLevelGroups(levels);
    expect(groups.length).toBe(2);
  });
});
