import { describe, expect, test } from "bun:test";
import { HARTREE_TO_KCAL } from "../lib/constants";
import type { NEBImage, NEBIteration } from "./neb";
import { buildBarrierChart, buildImageChartData, buildMepChart, closestImageIndex } from "./nebPath";

function img(index: number, distance: number, energy: number): NEBImage {
  return { index, distance, energy };
}

describe("buildMepChart", () => {
  const images = [img(0, 0, 0), img(1, 1.5, 0.01)];

  test("prefers interpolated points and converts Eh to kcal/mol", () => {
    const chart = buildMepChart([{ distance: 0.5, energy: 0.002 }], images, false);
    expect(chart).toEqual([{ x: 0.5, y: 0.002 * HARTREE_TO_KCAL }]);
  });

  test("falls back to image energies, converting when not from a path summary", () => {
    const chart = buildMepChart(undefined, images, false);
    expect(chart[1]).toEqual({ x: 1.5, y: 0.01 * HARTREE_TO_KCAL });
  });

  test("path-summary image energies pass through unconverted", () => {
    const chart = buildMepChart([], images, true);
    expect(chart[1]).toEqual({ x: 1.5, y: 0.01 });
  });

  test("empty inputs yield an empty chart", () => {
    expect(buildMepChart(undefined, [], false)).toEqual([]);
  });
});

describe("buildImageChartData", () => {
  test("converts only when energies are in Hartree", () => {
    const images = [img(0, 0.2, 0.005)];
    expect(buildImageChartData(images, true)).toEqual([{ x: 0.2, y: 0.005 }]);
    expect(buildImageChartData(images, false)).toEqual([{ x: 0.2, y: 0.005 * HARTREE_TO_KCAL }]);
  });
});

describe("buildBarrierChart", () => {
  test("maps iterations to barrier heights in kcal/mol", () => {
    const iterations: NEBIteration[] = [
      { iter: 1, hei: 3, barrierEh: 0.02, maxFp: 0, rmsFp: 0, isCI: false },
      { iter: 2, hei: 3, barrierEh: 0.018, maxFp: 0, rmsFp: 0, isCI: true },
    ];
    expect(buildBarrierChart(iterations)).toEqual([
      { x: 1, y: 0.02 * HARTREE_TO_KCAL },
      { x: 2, y: 0.018 * HARTREE_TO_KCAL },
    ]);
  });

  test("undefined iterations yield an empty chart", () => {
    expect(buildBarrierChart(undefined)).toEqual([]);
  });
});

describe("closestImageIndex", () => {
  const images = [img(0, 0, 0), img(1, 1.0, 0), img(2, 2.5, 0)];

  test("picks the image nearest to the clicked distance", () => {
    expect(closestImageIndex(images, 0.9)).toBe(1);
    expect(closestImageIndex(images, 2.0)).toBe(2);
    expect(closestImageIndex(images, -5)).toBe(0);
  });

  test("ties resolve to the earlier image", () => {
    expect(closestImageIndex(images, 0.5)).toBe(0);
  });

  test("empty image list returns 0", () => {
    expect(closestImageIndex([], 1)).toBe(0);
  });
});
