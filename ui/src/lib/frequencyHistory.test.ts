import { expect, test } from "bun:test";
import { groupFrequenciesByHessian } from "./frequencyHistory";
import type { Frequency } from "../data/types";

function f(idx: number, wavenumber: number, hessIdx?: number): Frequency {
  return { idx, wavenumber, imaginary: wavenumber < 0, hessIdx };
}

test("empty input", () => {
  const h = groupFrequenciesByHessian(undefined);
  expect(h.hessIndices).toEqual([]);
  expect(h.latest).toEqual([]);
  expect(h.latestHessIdx).toBeNull();
});

test("legacy rows without hessIdx all count as latest", () => {
  const h = groupFrequenciesByHessian([f(1, 1600), f(0, -512)]);
  expect(h.hessIndices).toEqual([]);
  expect(h.latestHessIdx).toBeNull();
  expect(h.latest.map((x) => x.idx)).toEqual([0, 1]);
});

test("groups by hessIdx, latest = max ordinal", () => {
  const h = groupFrequenciesByHessian([
    f(0, -512, 1),
    f(1, 1600, 1),
    f(0, -100, 2),
    f(1, 1650, 2),
  ]);
  expect(h.hessIndices).toEqual([1, 2]);
  expect(h.latestHessIdx).toBe(2);
  expect(h.latest.map((x) => x.wavenumber)).toEqual([-100, 1650]);
  expect(h.byHess.get(1)!.map((x) => x.wavenumber)).toEqual([-512, 1600]);
});

test("stale legacy rows are ignored once stamped rows exist", () => {
  const h = groupFrequenciesByHessian([f(0, -512), f(0, -100, 3)]);
  expect(h.hessIndices).toEqual([3]);
  expect(h.latest.map((x) => x.wavenumber)).toEqual([-100]);
});
