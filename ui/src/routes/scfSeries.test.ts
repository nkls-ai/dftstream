import { describe, expect, test } from "bun:test";
import type { MetricPoint } from "../data/types";
import { scfPassLabel, scfPasses, scfDeltaTone, scfSeriesStats } from "./scfSeries";

const points: MetricPoint[] = [
  { ts: 1, cycle: 2, iter: 1, value: -10.5 },
  { ts: 2, cycle: 0, iter: 2, value: -10.1 },
  { ts: 3, iter: 1, value: -10.0 },
  { ts: 4, cycle: 2, iter: 0, value: -10.4 },
];

describe("scfPasses", () => {
  test("groups by cycle (missing = 0), sorts by iter within a pass", () => {
    const passes = scfPasses(points);
    expect(passes.map((p) => [p.cycle, p.pass, p.passCount])).toEqual([
      [0, 1, 1],
      [2, 1, 1],
    ]);
    expect(passes[0]!.series).toEqual([
      { x: 1, y: -10.0 },
      { x: 2, y: -10.1 },
    ]);
    expect(passes[1]!.series).toEqual([
      { x: 0, y: -10.4 },
      { x: 1, y: -10.5 },
    ]);
  });

  test("a repeated iteration number starts a new SCF pass in the same cycle", () => {
    // Opt cycle 9 (5 iterations) followed by the final energy evaluation at
    // the stationary point (4 iterations), both filed under cycle 9.
    const final: MetricPoint[] = [
      ...[1, 2, 3, 4, 5].map((iter) => ({ ts: 100 + iter, cycle: 9, iter, value: -422.8851 - iter * 1e-7 })),
      ...[1, 2, 3, 4].map((iter) => ({ ts: 200, cycle: 9, iter, value: -422.8852 - iter * 1e-7 })),
    ];
    const passes = scfPasses(final);
    expect(passes.map((p) => [p.cycle, p.pass, p.passCount, p.series.length])).toEqual([
      [9, 1, 2, 5],
      [9, 2, 2, 4],
    ]);
    expect(passes[1]!.series.map((p) => p.x)).toEqual([1, 2, 3, 4]);
    expect(scfPassLabel(passes[1]!)).toBe("cycle 9 · SCF 2/2");
    expect(scfPassLabel({ cycle: 3, pass: 1, passCount: 1 })).toBe("cycle 3");
  });

  test("handles undefined", () => {
    expect(scfPasses(undefined)).toEqual([]);
  });
});

describe("scfSeriesStats", () => {
  test("empty series has null stats", () => {
    expect(scfSeriesStats([])).toEqual({ lastE: null, dE: null, span: null });
  });

  test("single point has energy but no delta", () => {
    expect(scfSeriesStats([{ x: 0, y: -1.5 }])).toEqual({ lastE: -1.5, dE: null, span: 0 });
  });

  test("multi point computes final delta and span", () => {
    const stats = scfSeriesStats([
      { x: 0, y: -10.0 },
      { x: 1, y: -10.4 },
      { x: 2, y: -10.5 },
    ]);
    expect(stats.lastE).toBe(-10.5);
    expect(stats.dE).toBeCloseTo(-0.1, 12);
    expect(stats.span).toBeCloseTo(0.5, 12);
  });
});

describe("scfDeltaTone", () => {
  test("thresholds", () => {
    expect(scfDeltaTone(null)).toBeUndefined();
    expect(scfDeltaTone(1e-7)).toBe("ok");
    expect(scfDeltaTone(-1e-7)).toBe("ok");
    expect(scfDeltaTone(1e-5)).toBe("warn");
    expect(scfDeltaTone(1e-3)).toBeUndefined();
  });
});
