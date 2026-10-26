// Pure chart-series builders for the NEB tab. When the parsed output carries a
// PATH SUMMARY (usePathSummary), image energies are already relative kcal/mol;
// otherwise they are Hartree and need converting.

import { HARTREE_TO_KCAL } from "../lib/constants";
import type { NEBImage, NEBIteration } from "./neb";

export interface ChartPoint {
  x: number;
  y: number;
}

/** An image's energy relative to the path reference, in kcal/mol. */
export function imageRelKcal(img: Pick<NEBImage, "energy">, usePathSummary: boolean): number {
  return usePathSummary ? img.energy : img.energy * HARTREE_TO_KCAL;
}

export function buildMepChart(
  interp: { distance: number; energy: number }[] | undefined,
  images: NEBImage[],
  usePathSummary: boolean,
): ChartPoint[] {
  if (interp?.length) {
    return interp.map((p) => ({ x: p.distance, y: p.energy * HARTREE_TO_KCAL }));
  }
  if (images.length) {
    return images.map((img) => ({ x: img.distance, y: imageRelKcal(img, usePathSummary) }));
  }
  return [];
}

export function buildImageChartData(images: NEBImage[], usePathSummary: boolean): ChartPoint[] {
  return images.map((img) => ({ x: img.distance, y: imageRelKcal(img, usePathSummary) }));
}

export function buildBarrierChart(iterations: NEBIteration[] | undefined): ChartPoint[] {
  return (iterations ?? []).map((it) => ({ x: it.iter, y: it.barrierEh * HARTREE_TO_KCAL }));
}

// Index of the image whose reaction-coordinate distance is closest to `dist`.
export function closestImageIndex(images: NEBImage[], dist: number): number {
  let closest = 0;
  let minDiff = Infinity;
  for (let j = 0; j < images.length; j++) {
    const diff = Math.abs(images[j]!.distance - dist);
    if (diff < minDiff) { minDiff = diff; closest = j; }
  }
  return closest;
}
