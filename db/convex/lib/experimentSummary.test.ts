import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import {
  computeExperimentSummary,
  emptyExperimentProgress,
  experimentDelta,
  isZeroExperimentDelta,
  mergeExperimentProgress,
  sumExperimentProgress,
  type ExperimentProgressValues,
  type ExperimentRun,
  type LatestRun,
} from "./experimentSummary";

const experimentId = "exp1" as Id<"experiments">;

const exp = {
  _id: experimentId,
  name: "hydrogenation",
  createdAt: 1000,
};

let nextId = 0;
function run(overrides: Partial<ExperimentRun> = {}): ExperimentRun {
  return {
    experimentId,
    status: "finished",
    functional: undefined,
    basis: undefined,
    runTypes: undefined,
    ...overrides,
  };
}

function latestRun(overrides: Partial<LatestRun> = {}): LatestRun {
  nextId++;
  return {
    _id: `run${nextId}` as Id<"runs">,
    status: "finished",
    name: undefined,
    startedAt: 2000,
    finishedAt: undefined,
    lastEnergy: undefined,
    ...overrides,
  };
}

/** The rollup as it would be after `runs` were created, i.e. the merge of one
 *  creation delta per run. */
function rollupOf(runs: ExperimentRun[]): ExperimentProgressValues {
  return mergeExperimentProgress(
    experimentId,
    runs.map((r) => experimentDelta(experimentId, null, r, 0)),
    0,
  );
}

describe("experimentDelta", () => {
  test("a creation adds one run in its status bucket", () => {
    const d = experimentDelta(
      experimentId,
      null,
      run({
        status: "running",
        functional: "B3LYP",
        basis: "def2-SVP",
        runTypes: ["Opt"],
      }),
      0,
    );
    expect(d).toMatchObject({
      total: 1,
      running: 1,
      finished: 0,
      failed: 0,
      functionalCounts: { B3LYP: 1 },
      basisCounts: { "def2-SVP": 1 },
      runTypeCounts: { Opt: 1 },
    });
  });

  test("a deletion is the exact negation of the creation", () => {
    const r = run({ status: "failed", functional: "PBE0", runTypes: ["Freq"] });
    const created = experimentDelta(experimentId, null, r, 0);
    const deleted = experimentDelta(experimentId, r, null, 0);
    expect(
      sumExperimentProgress(experimentId, [created, deleted], 0),
    ).toMatchObject({
      total: 0,
      failed: 0,
      functionalCounts: {},
      runTypeCounts: {},
    });
  });

  test("pending counts as running", () => {
    expect(
      experimentDelta(experimentId, null, run({ status: "pending" }), 0).running,
    ).toBe(1);
  });

  test("a status transition moves one run between buckets and nothing else", () => {
    const before = run({ status: "running", functional: "B3LYP" });
    const d = experimentDelta(
      experimentId,
      before,
      { ...before, status: "finished" },
      0,
    );
    expect(d).toMatchObject({ total: 0, running: -1, finished: 1 });
    // The functional did not change, so the delta carries no functional key at
    // all — this is what keeps rollup rows small.
    expect(d.functionalCounts).toEqual({});
  });

  test("a write that changes nothing the rollup counts is a zero delta", () => {
    const r = run({
      status: "finished",
      functional: "B3LYP",
      basis: "def2-SVP",
    });
    expect(
      isZeroExperimentDelta(experimentDelta(experimentId, r, { ...r }, 0)),
    ).toBe(true);
    expect(
      isZeroExperimentDelta(experimentDelta(experimentId, null, r, 0)),
    ).toBe(false);
    expect(isZeroExperimentDelta(emptyExperimentProgress(experimentId, 0))).toBe(
      true,
    );
  });
});

describe("sum / merge", () => {
  test("summing does not clamp — a subset of the rows may go negative", () => {
    const r = run({ status: "finished" });
    const removal = experimentDelta(experimentId, r, null, 0);
    expect(sumExperimentProgress(experimentId, [removal], 0)).toMatchObject({
      total: -1,
      finished: -1,
    });
  });

  test("merging clamps counters and drops non-positive tally keys", () => {
    const r = run({ status: "finished", functional: "B3LYP" });
    const removal = experimentDelta(experimentId, r, null, 0);
    const merged = mergeExperimentProgress(experimentId, [removal], 0);
    expect(merged).toMatchObject({ total: 0, finished: 0 });
    expect(merged.functionalCounts).toEqual({});
  });
});

describe("computeExperimentSummary", () => {
  test("a zeroed rollup and no runs falls back to experiment metadata", () => {
    const s = computeExperimentSummary(
      exp,
      emptyExperimentProgress(experimentId, 0),
      null,
    );
    expect(s).toMatchObject({
      _id: exp._id,
      name: exp.name,
      createdAt: exp.createdAt,
      runCount: 0,
      runCountCapped: false,
      summaryPending: false,
      running: 0,
      finished: 0,
      failed: 0,
      lastActivity: exp.createdAt,
      latestStatus: undefined,
      latestRunName: undefined,
      latestRunId: undefined,
      latestLastEnergy: undefined,
      topFunctional: undefined,
      topBasis: undefined,
      topRunType: undefined,
    });
  });

  test("a missing rollup is reported as pending, not as zero runs", () => {
    const s = computeExperimentSummary(exp, null, null);
    expect(s.summaryPending).toBe(true);
    expect(s.runCount).toBe(0);
  });

  test("counts statuses; pending counts as running", () => {
    const s = computeExperimentSummary(
      exp,
      rollupOf([
        run({ status: "running" }),
        run({ status: "pending" }),
        run({ status: "finished" }),
        run({ status: "finished" }),
        run({ status: "failed" }),
      ]),
      null,
    );
    expect(s.running).toBe(2);
    expect(s.finished).toBe(2);
    expect(s.failed).toBe(1);
    expect(s.runCount).toBe(5);
    expect(s.runCountCapped).toBe(false);
  });

  test("the newest run drives lastActivity and the latest* fields", () => {
    const latest = latestRun({
      status: "running",
      name: "ts-search",
      startedAt: 9000,
    });
    const s = computeExperimentSummary(exp, rollupOf([run()]), latest);
    expect(s.latestRunId).toBe(latest._id);
    expect(s.latestRunName).toBe("ts-search");
    expect(s.latestStatus).toBe("running");
    // No finishedAt on the latest run → falls back to its startedAt.
    expect(s.lastActivity).toBe(9000);
  });

  test("prefers the latest run's finishedAt for lastActivity when present", () => {
    const s = computeExperimentSummary(
      exp,
      rollupOf([run()]),
      latestRun({ startedAt: 5000, finishedAt: 7000 }),
    );
    expect(s.lastActivity).toBe(7000);
  });

  test("top functional/basis/runType are the most frequent values", () => {
    const s = computeExperimentSummary(
      exp,
      rollupOf([
        run({ functional: "B3LYP", basis: "def2-SVP", runTypes: ["Opt"] }),
        run({
          functional: "B3LYP",
          basis: "def2-TZVP",
          runTypes: ["Opt", "Freq"],
        }),
        run({ functional: "PBE0", basis: "def2-TZVP", runTypes: ["Freq"] }),
        run({ functional: "B3LYP", basis: "def2-SVP", runTypes: ["Opt"] }),
      ]),
      null,
    );
    expect(s.topFunctional).toBe("B3LYP");
    expect(s.topBasis).toBe("def2-SVP");
    expect(s.topRunType).toBe("Opt");
  });

  test("a capped rollup read is flagged so the UI can render N+", () => {
    const rollup = rollupOf([run(), run()]);
    expect(
      computeExperimentSummary(exp, rollup, null, true).runCountCapped,
    ).toBe(true);
    expect(computeExperimentSummary(exp, rollup, null).runCountCapped).toBe(
      false,
    );
  });
});
