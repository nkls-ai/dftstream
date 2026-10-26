import { describe, expect, test } from "bun:test";
import { HARTREE_TO_KCAL } from "../lib/constants";
import type { IRCPathPoint, IRCSummary } from "./irc";
import {
  buildIRCAnnotations,
  buildIRCChartData,
  ircEndpointDeltasKcal,
  ircStepLabel,
} from "./ircDisplay";

const path: IRCPathPoint[] = [
  { pathIndex: -2, energy: -100.02, relativeKcal: -12.5, direction: "backward", step: 2 },
  { pathIndex: -1, energy: -100.01, relativeKcal: -6.2, direction: "backward", step: 1 },
  { pathIndex: 0, energy: -100.0, relativeKcal: 0, direction: "forward", step: 0 },
  { pathIndex: 1, energy: -100.03, relativeKcal: -18.8, direction: "forward", step: 1 },
];

describe("buildIRCChartData", () => {
  test("maps pathIndex/relativeKcal to x/y", () => {
    expect(buildIRCChartData(path.slice(0, 2))).toEqual([
      { x: -2, y: -12.5 },
      { x: -1, y: -6.2 },
    ]);
  });
});

describe("buildIRCAnnotations", () => {
  test("marks TS, reactant, and product", () => {
    expect(buildIRCAnnotations(path)).toEqual([
      { x: 0, y: 0, label: "TS", hue: "gold" },
      { x: -2, y: -12.5, label: "R", hue: "teal" },
      { x: 1, y: -18.8, label: "P", hue: "violet" },
    ]);
  });

  test("omits TS annotation when no pathIndex 0 point exists", () => {
    const labels = buildIRCAnnotations(path.filter((p) => p.pathIndex !== 0)).map((a) => a.label);
    expect(labels).toEqual(["R", "P"]);
  });

  test("empty path has no annotations", () => {
    expect(buildIRCAnnotations([])).toEqual([]);
  });
});

describe("ircEndpointDeltasKcal", () => {
  const summary: IRCSummary = {
    forward: [
      { step: 0, direction: "forward", energy: -100.0, dE: 0 },
      { step: 1, direction: "forward", energy: -100.03, dE: -0.03 },
    ],
    backward: [{ step: 1, direction: "backward", energy: -100.01, dE: -0.01 }],
    tsEnergy: -100.0,
    converged: true,
  };

  test("computes deltas from direction endpoints relative to TS", () => {
    const { fwdDeltaKcal, bwdDeltaKcal } = ircEndpointDeltasKcal(summary);
    expect(fwdDeltaKcal).toBeCloseTo(-0.03 * HARTREE_TO_KCAL, 8);
    expect(bwdDeltaKcal).toBeCloseTo(-0.01 * HARTREE_TO_KCAL, 8);
  });

  test("missing direction yields null", () => {
    const { fwdDeltaKcal, bwdDeltaKcal } = ircEndpointDeltasKcal({
      ...summary,
      backward: [],
    });
    expect(fwdDeltaKcal).not.toBeNull();
    expect(bwdDeltaKcal).toBeNull();
  });

  test("null tsEnergy falls back to zero reference", () => {
    const { fwdDeltaKcal } = ircEndpointDeltasKcal({ ...summary, tsEnergy: null });
    expect(fwdDeltaKcal).toBeCloseTo(-100.03 * HARTREE_TO_KCAL, 6);
  });
});

describe("ircStepLabel", () => {
  const tsIdx = path.findIndex((p) => p.pathIndex === 0);

  test("labels endpoints and TS", () => {
    expect(ircStepLabel(0, path, tsIdx)).toBe("Reactant");
    expect(ircStepLabel(tsIdx, path, tsIdx)).toBe("TS");
    expect(ircStepLabel(path.length - 1, path, tsIdx)).toBe("Product");
  });

  test("labels intermediate points by pathIndex", () => {
    expect(ircStepLabel(1, path, tsIdx)).toBe("step -1");
  });
});
