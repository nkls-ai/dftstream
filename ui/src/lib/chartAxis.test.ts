import { describe, expect, test } from "bun:test";
import { niceAxis, tickDecimalsForSpan, valueSpan } from "./chartAxis";

describe("tickDecimalsForSpan", () => {
  test("coarse spans need few decimals", () => {
    expect(tickDecimalsForSpan(80)).toBe(0);
    expect(tickDecimalsForSpan(0.229)).toBe(2);
  });

  test("a converged SCF span needs enough decimals to separate ticks", () => {
    expect(tickDecimalsForSpan(4e-6)).toBe(6);
  });

  test("flat / invalid spans fall back to a fixed precision", () => {
    expect(tickDecimalsForSpan(0)).toBe(4);
    expect(tickDecimalsForSpan(Number.NaN)).toBe(4);
  });

  test("clamps absurdly small spans", () => {
    expect(tickDecimalsForSpan(1e-15)).toBe(10);
  });
});

describe("valueSpan", () => {
  test("ignores non-finite values", () => {
    expect(valueSpan([1, Number.NaN, 4, Infinity])).toBe(3);
    expect(valueSpan([2])).toBe(0);
    expect(valueSpan([])).toBe(0);
  });
});

describe("niceAxis", () => {
  test("converged SCF cycle: distinct ticks, one shared precision", () => {
    const axis = niceAxis([-422.8851079692, -422.8851129794, -422.8851135806, -422.8851144225])!;
    const labels = axis.ticks.map(axis.format);
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(labels.map((l) => l.split(".")[1]!.length)).size).toBe(1);
    expect(labels[0]).toBe("-422.885116");
    expect(axis.domain[0]).toBeLessThanOrEqual(-422.8851144225);
    expect(axis.domain[1]).toBeGreaterThanOrEqual(-422.8851079692);
  });

  test("kcal/mol profile gets round ticks", () => {
    const axis = niceAxis([0, 73.2, 20.0])!;
    expect(axis.ticks).toEqual([0, 20, 40, 60, 80]);
    expect(axis.ticks.map(axis.format)).toEqual(["0", "20", "40", "60", "80"]);
  });

  test("2.5-steps carry the extra decimal they need", () => {
    const axis = niceAxis([0, 0.1])!;
    expect(axis.ticks).toEqual([0, 0.025, 0.05, 0.075, 0.1]);
    expect(axis.format(0.025)).toBe("0.025");
    expect(axis.format(0.05)).toBe("0.050");
  });

  test("flat or empty data defers to recharts", () => {
    expect(niceAxis([1, 1])).toBeNull();
    expect(niceAxis([])).toBeNull();
    expect(niceAxis([Number.NaN])).toBeNull();
  });
});
