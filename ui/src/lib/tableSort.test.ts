import { test, expect } from "bun:test";
import { toggleSort, compareValues, sortRows, ariaSort } from "./tableSort";

test("toggleSort cycles default -> flipped -> cleared", () => {
  const first = toggleSort(null, "energy", "asc");
  expect(first).toEqual({ key: "energy", dir: "asc" });
  const second = toggleSort(first, "energy", "asc");
  expect(second).toEqual({ key: "energy", dir: "desc" });
  expect(toggleSort(second, "energy", "asc")).toBeNull();
});

test("toggleSort switching columns starts at the new column's default", () => {
  const state = { key: "name", dir: "desc" as const };
  expect(toggleSort(state, "energy", "desc")).toEqual({ key: "energy", dir: "desc" });
});

test("toggleSort respects a desc default direction", () => {
  const first = toggleSort(null, "date", "desc");
  expect(first).toEqual({ key: "date", dir: "desc" });
  expect(toggleSort(first, "date", "desc")).toEqual({ key: "date", dir: "asc" });
  expect(toggleSort({ key: "date", dir: "asc" }, "date", "desc")).toBeNull();
});

test("compareValues orders numbers numerically", () => {
  expect(compareValues(2, 10)).toBeLessThan(0);
  expect(compareValues(-1.5, -2)).toBeGreaterThan(0);
  expect(compareValues(3, 3)).toBe(0);
});

test("compareValues orders strings case-insensitively and numerically", () => {
  expect(compareValues("apple", "Banana")).toBeLessThan(0);
  expect(compareValues("run2", "run10")).toBeLessThan(0);
});

test("compareValues collates null, undefined, and NaN last", () => {
  expect(compareValues(null, 5)).toBeGreaterThan(0);
  expect(compareValues(5, undefined)).toBeLessThan(0);
  expect(compareValues(Number.NaN, 5)).toBeGreaterThan(0);
  expect(compareValues(null, undefined)).toBe(0);
});

const rows = [
  { name: "b", energy: -5, note: null as string | null },
  { name: "a", energy: -7, note: "x" },
  { name: "c", energy: null as number | null, note: "y" },
];
const accessors = {
  name: (r: (typeof rows)[number]) => r.name,
  energy: (r: (typeof rows)[number]) => r.energy,
};

test("sortRows sorts by the active column without mutating input", () => {
  const before = [...rows];
  const asc = sortRows(rows, { key: "energy", dir: "asc" }, accessors);
  expect(asc.map((r) => r.name)).toEqual(["a", "b", "c"]);
  expect(rows).toEqual(before);
});

test("sortRows keeps missing values last in both directions", () => {
  const desc = sortRows(rows, { key: "energy", dir: "desc" }, accessors);
  expect(desc.map((r) => r.name)).toEqual(["b", "a", "c"]);
});

test("sortRows returns input untouched when cleared or key unknown", () => {
  expect(sortRows(rows, null, accessors)).toBe(rows);
  expect(sortRows(rows, { key: "missing", dir: "asc" }, accessors)).toBe(rows);
});

test("ariaSort reflects the active column only", () => {
  const state = { key: "energy", dir: "asc" as const };
  expect(ariaSort(state, "energy")).toBe("ascending");
  expect(ariaSort({ key: "energy", dir: "desc" }, "energy")).toBe("descending");
  expect(ariaSort(state, "name")).toBe("none");
  expect(ariaSort(null, "name")).toBe("none");
});
