import { test, expect, describe } from "bun:test";
import type { BatchProgress } from "../data/types";
import type { RankedRun } from "./batchStats";
import {
  deriveBatchMetrics,
  failureRows,
  groupByParam,
  MIN_ETA_SAMPLES,
  pageEnergySpread,
  paramKeys,
  quantile,
  UNSET_PARAM_VALUE,
} from "./batchProgress";

const HOUR = 3_600_000;

function progress(overrides: Partial<BatchProgress> = {}): BatchProgress {
  return {
    batchId: "b1",
    experimentId: "e1",
    total: 0,
    pending: 0,
    running: 0,
    finished: 0,
    failed: 0,
    converged: 0,
    notConverged: 0,
    optMaxCycles: 0,
    withImaginary: 0,
    missingThermo: 0,
    suspicious: 0,
    wallclockSumSec: 0,
    wallclockSumSqSec: 0,
    coreSecondsSum: 0,
    energySumEh: 0,
    energyCount: 0,
    failureCounts: {},
    updatedAt: 0,
    ...overrides,
  };
}

/** A batch of `n` finished runs that each took exactly `sec`. */
function uniformFinished(n: number, sec: number, extra: Partial<BatchProgress> = {}) {
  return progress({
    total: n,
    finished: n,
    wallclockSumSec: n * sec,
    wallclockSumSqSec: n * sec * sec,
    coreSecondsSum: n * sec,
    ...extra,
  });
}

describe("deriveBatchMetrics — progress", () => {
  test("percent counts terminal runs against the batch total", () => {
    const m = deriveBatchMetrics(
      progress({ total: 2400, pending: 1000, running: 400, finished: 900, failed: 100 }),
      0,
    );
    // The whole point of the rollup: 2400, not the 1000 a capped read returns.
    expect(m.total).toBe(2400);
    expect(m.terminal).toBe(1000);
    expect(m.remaining).toBe(1400);
    expect(m.percent).toBeCloseTo(41.666, 2);
  });

  test("an empty batch is 0% rather than NaN", () => {
    expect(deriveBatchMetrics(progress(), 0).percent).toBe(0);
  });
});

describe("deriveBatchMetrics — throughput and ETA", () => {
  test("completions per hour uses elapsed time since the first start", () => {
    const p = uniformFinished(10, 60, { firstStartedAt: 0 });
    expect(deriveBatchMetrics(p, 2 * HOUR).completionsPerHour).toBeCloseTo(5, 6);
  });

  test("no rate before a minute has elapsed — 1 run is not 3600/hour", () => {
    const p = uniformFinished(1, 1, { firstStartedAt: 0 });
    expect(deriveBatchMetrics(p, 1000).completionsPerHour).toBeUndefined();
  });

  test("no rate without a first start", () => {
    expect(deriveBatchMetrics(uniformFinished(5, 60), HOUR).completionsPerHour).toBeUndefined();
  });

  test("ETA is suppressed below the sample floor", () => {
    const few = uniformFinished(MIN_ETA_SAMPLES - 1, 100, { total: 100, pending: 96 });
    expect(deriveBatchMetrics(few, 0).eta).toBeUndefined();
    const enough = uniformFinished(MIN_ETA_SAMPLES, 100, { total: 100, pending: 95 });
    expect(deriveBatchMetrics(enough, 0).eta).toBeDefined();
  });

  test("ETA is suppressed once nothing is left to run", () => {
    expect(deriveBatchMetrics(uniformFinished(10, 100), 0).eta).toBeUndefined();
  });

  test("zero-variance durations give p50 == p90", () => {
    const p = uniformFinished(10, 100, { total: 20, pending: 10 });
    const m = deriveBatchMetrics(p, 0);
    expect(m.duration?.sdSec).toBeCloseTo(0, 9);
    expect(m.eta?.p50Sec).toBeCloseTo(1000, 6); // 10 remaining, 1 assumed slot
    expect(m.eta?.p90Sec).toBeCloseTo(1000, 6);
  });

  test("a spread of durations widens p90 above p50", () => {
    // Durations 100 and 300: mean 200, sd 100.
    const p = progress({
      total: 12,
      pending: 10,
      finished: 2,
      wallclockSumSec: 400,
      wallclockSumSqSec: 100_000,
    });
    const m = deriveBatchMetrics({ ...p, finished: 2 }, 0);
    expect(m.duration?.meanSec).toBeCloseTo(200, 6);
    expect(m.duration?.sdSec).toBeCloseTo(100, 6);
  });

  test("concurrency divides the remaining work; none assumes a single slot", () => {
    const parallel = uniformFinished(10, 100, { total: 30, running: 20, pending: 0 });
    const eta = deriveBatchMetrics(parallel, 0).eta;
    expect(eta?.observedConcurrency).toBe(20);
    expect(eta?.assumedConcurrency).toBe(20);
    expect(eta?.p50Sec).toBeCloseTo(100, 6); // 20 remaining / 20 slots × 100s

    const stalled = uniformFinished(10, 100, { total: 30, running: 0, pending: 20 });
    const stalledEta = deriveBatchMetrics(stalled, 0).eta;
    expect(stalledEta?.observedConcurrency).toBe(0);
    expect(stalledEta?.assumedConcurrency).toBe(1);
    expect(stalledEta?.p50Sec).toBeCloseTo(2000, 6);
  });

  test("core-hours are projected at the observed cost per terminal run", () => {
    const p = progress({ total: 100, finished: 10, pending: 90, coreSecondsSum: 36_000 });
    const m = deriveBatchMetrics(p, 0);
    expect(m.coreHoursUsed).toBeCloseTo(10, 6);
    expect(m.coreHoursProjected).toBeCloseTo(100, 6);
  });

  test("no projection before anything is terminal", () => {
    expect(deriveBatchMetrics(progress({ total: 10, pending: 10 }), 0).coreHoursProjected)
      .toBeUndefined();
  });
});

describe("deriveBatchMetrics — quality rates", () => {
  test("converged rate excludes runs that reported no flag at all", () => {
    const m = deriveBatchMetrics(
      progress({ total: 10, finished: 10, converged: 6, notConverged: 2 }),
      0,
    );
    expect(m.convergedRate).toBeCloseTo(0.75, 6);
  });

  test("imaginary and missing-thermo rates are over finished runs", () => {
    const m = deriveBatchMetrics(
      progress({ total: 10, finished: 8, failed: 2, withImaginary: 2, missingThermo: 4 }),
      0,
    );
    expect(m.imaginaryRate).toBeCloseTo(0.25, 6);
    expect(m.missingThermoRate).toBeCloseTo(0.5, 6);
  });

  test("rates are undefined, not NaN, with an empty denominator", () => {
    const m = deriveBatchMetrics(progress({ total: 3, pending: 3 }), 0);
    expect(m.convergedRate).toBeUndefined();
    expect(m.imaginaryRate).toBeUndefined();
    expect(m.optMaxCyclesRate).toBeUndefined();
  });
});

describe("deriveBatchMetrics — energy", () => {
  test("mean and spread come from the sums, not from loaded rows", () => {
    const m = deriveBatchMetrics(
      progress({ total: 2, finished: 2, energySumEh: -152.8, energyCount: 2, minEnergyEh: -76.5 }),
      0,
    );
    expect(m.energy.meanEh).toBeCloseTo(-76.4, 6);
    expect(m.energy.spreadKcal).toBeCloseTo(0.1 * 627.5094740631, 4);
  });

  test("no energies means no mean", () => {
    const m = deriveBatchMetrics(progress({ total: 1, finished: 1 }), 0);
    expect(m.energy.count).toBe(0);
    expect(m.energy.meanEh).toBeUndefined();
    expect(m.energy.spreadKcal).toBeUndefined();
  });
});

describe("failureRows", () => {
  test("labels known classes, decodes exit-code buckets and sorts by count", () => {
    const rows = failureRows(
      { scf_not_converged: 5, "exit:137": 3, out_of_memory: 1 },
      9,
    );
    expect(rows.map((r) => r.key)).toEqual(["scf_not_converged", "exit:137", "out_of_memory"]);
    expect(rows[0]!.label).toBe("SCF not converged");
    expect(rows[0]!.share).toBeCloseTo(5 / 9, 6);
    expect(rows[1]!.label).toBe("Exit code 137");
    expect(rows[1]!.unclassified).toBe(true);
    expect(rows[0]!.unclassified).toBe(false);
  });

  test("survives a class this build has never heard of", () => {
    const rows = failureRows({ some_future_class: 2 }, 2);
    expect(rows[0]!.label).toBe("some future class");
  });

  test("drops empty buckets and tolerates a zero total", () => {
    expect(failureRows({ unknown: 0 }, 0)).toEqual([]);
  });
});

describe("pageEnergySpread", () => {
  function ranked(id: string, relativeKcal?: number): RankedRun {
    return {
      id,
      status: "finished",
      startedAt: 0,
      relativeKcal,
    } as RankedRun;
  }

  test("flags the run past the upper Tukey fence", () => {
    const rows = [
      ranked("a", 0),
      ranked("b", 1),
      ranked("c", 2),
      ranked("d", 3),
      ranked("e", 100),
    ];
    const s = pageEnergySpread(rows);
    expect(s.count).toBe(5);
    expect(s.medianKcal).toBeCloseTo(2, 6);
    expect(s.outlierIds).toEqual(["e"]);
  });

  test("identical energies flag nothing (a zero IQR is not an outlier machine)", () => {
    const rows = [ranked("a", 5), ranked("b", 5), ranked("c", 5)];
    expect(pageEnergySpread(rows).outlierIds).toEqual([]);
  });

  test("runs without an energy are ignored entirely", () => {
    const s = pageEnergySpread([ranked("a"), ranked("b", 1)]);
    expect(s.count).toBe(1);
    expect(s.outlierIds).toEqual([]);
  });

  test("no energies at all is empty, not NaN", () => {
    const s = pageEnergySpread([ranked("a")]);
    expect(s.count).toBe(0);
    expect(s.medianKcal).toBeUndefined();
  });
});

describe("quantile", () => {
  test("interpolates between neighbours", () => {
    expect(quantile([0, 10], 0.5)).toBeCloseTo(5, 6);
    expect(quantile([0, 1, 2, 3], 0.25)).toBeCloseTo(0.75, 6);
  });
  test("an empty sample is NaN, and the caller must not ask", () => {
    expect(Number.isNaN(quantile([], 0.5))).toBe(true);
  });
});

describe("groupByParam", () => {
  function ranked(
    id: string,
    params: Record<string, string | number | boolean> | undefined,
    relativeKcal?: number,
    status: "finished" | "failed" = "finished",
  ): RankedRun {
    return { id, status, startedAt: 0, batchParams: params, relativeKcal } as RankedRun;
  }

  test("paramKeys is the sorted union across the loaded runs", () => {
    expect(
      paramKeys([
        ranked("a", { solvent: "water", basis: "svp" }),
        ranked("b", { functional: "B3LYP" }),
        ranked("c", undefined),
      ]),
    ).toEqual(["basis", "functional", "solvent"]);
  });

  test("buckets by value with per-group counts and energies", () => {
    const groups = groupByParam(
      [
        ranked("a", { solvent: "water" }, 0),
        ranked("b", { solvent: "water" }, 4),
        ranked("c", { solvent: "thf" }, 2, "failed"),
      ],
      "solvent",
    );
    expect(groups[0]).toMatchObject({ value: "water", count: 2, finished: 2, failed: 0 });
    expect(groups[0]!.medianKcal).toBeCloseTo(2, 6);
    expect(groups[0]!.bestKcal).toBeCloseTo(0, 6);
    expect(groups[1]).toMatchObject({ value: "thf", count: 1, finished: 0, failed: 1 });
  });

  test("runs missing the key land in their own bucket", () => {
    const groups = groupByParam([ranked("a", { x: 1 }), ranked("b", {})], "x");
    expect(groups.map((g) => g.value).sort()).toEqual([UNSET_PARAM_VALUE, "1"]);
  });

  test("numeric and boolean values stringify consistently", () => {
    const groups = groupByParam(
      [ranked("a", { n: 4 }), ranked("b", { n: 4 }), ranked("c", { n: true })],
      "n",
    );
    expect(groups.map((g) => g.value)).toEqual(["4", "true"]);
  });
});
