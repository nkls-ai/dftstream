import { describe, expect, test } from "bun:test";
import type { PathwayPoint } from "../data/types";
import {
  appendPoint,
  insertPoint,
  removePointAt,
  reorderPoints,
  roleForInsert,
  setPointRole,
} from "./pathwayDraft";

function draft(...runIds: string[]): PathwayPoint[] {
  return runIds.map((runId, i) => ({
    runId,
    role: i === 0 ? "reactant" : "intermediate",
    order: i,
  }));
}

describe("roleForInsert", () => {
  test("first point is the reactant, later points are intermediates", () => {
    expect(roleForInsert(0)).toBe("reactant");
    expect(roleForInsert(1)).toBe("intermediate");
    expect(roleForInsert(5)).toBe("intermediate");
  });
});

describe("appendPoint", () => {
  test("appends with sequential order", () => {
    const d = appendPoint(appendPoint([], "a"), "b");
    expect(d).toEqual([
      { runId: "a", role: "reactant", order: 0 },
      { runId: "b", role: "intermediate", order: 1 },
    ]);
  });

  test("does not mutate the input", () => {
    const d = draft("a");
    appendPoint(d, "b");
    expect(d).toHaveLength(1);
  });
});

describe("insertPoint", () => {
  test("inserts in the middle and renumbers", () => {
    const d = insertPoint(draft("a", "c"), "b", 1);
    expect(d.map((p) => p.runId)).toEqual(["a", "b", "c"]);
    expect(d.map((p) => p.order)).toEqual([0, 1, 2]);
    expect(d[1]!.role).toBe("intermediate");
  });

  test("inserting at the front makes the new point the reactant", () => {
    const d = insertPoint(draft("b"), "a", 0);
    expect(d[0]).toEqual({ runId: "a", role: "reactant", order: 0 });
    // The displaced former first point keeps its role — matching the
    // builder, which only assigns roles at insert time.
    expect(d[1]!.runId).toBe("b");
    expect(d[1]!.order).toBe(1);
  });
});

describe("removePointAt", () => {
  test("removes and renumbers", () => {
    const d = removePointAt(draft("a", "b", "c"), 1);
    expect(d.map((p) => p.runId)).toEqual(["a", "c"]);
    expect(d.map((p) => p.order)).toEqual([0, 1]);
  });
});

describe("reorderPoints", () => {
  test("moves forward and renumbers", () => {
    const d = reorderPoints(draft("a", "b", "c"), 0, 2);
    expect(d.map((p) => p.runId)).toEqual(["b", "c", "a"]);
    expect(d.map((p) => p.order)).toEqual([0, 1, 2]);
  });

  test("moves backward", () => {
    const d = reorderPoints(draft("a", "b", "c"), 2, 0);
    expect(d.map((p) => p.runId)).toEqual(["c", "a", "b"]);
  });

  test("no-op when from === to returns the same array", () => {
    const d = draft("a", "b");
    expect(reorderPoints(d, 1, 1)).toBe(d);
  });
});

describe("setPointRole", () => {
  test("changes only the targeted point", () => {
    const d = setPointRole(draft("a", "b"), 1, "ts");
    expect(d[0]!.role).toBe("reactant");
    expect(d[1]!.role).toBe("ts");
  });
});
