import { describe, expect, test } from "vitest";
import type { Doc, Id } from "../_generated/dataModel";
import { ERROR_CLASS, RUN_STATUS } from "../schema";
import {
  applyContribution,
  emptyProgress,
  EXIT_CODE_KEY_PREFIX,
  failureKeyOf,
  isZeroContributionChange,
  mergeProgress,
  projectBatchRow,
  runContribution,
  runWallclockSec,
  sumProgress,
  zeroCounters,
  type ProgressRun,
  type ProgressValues,
} from "./batchSummary";

const BATCH = "batch1" as Id<"batches">;
const EXPERIMENT = "exp1" as Id<"experiments">;

function run(overrides: Partial<ProgressRun> = {}): ProgressRun {
  return {
    status: RUN_STATUS.PENDING,
    exitCode: undefined,
    errorClass: undefined,
    converged: undefined,
    optMaxCycles: undefined,
    imaginaryModes: undefined,
    gibbsEh: undefined,
    lastEnergy: undefined,
    wallclockSec: undefined,
    nprocs: undefined,
    ncores: undefined,
    startedAt: 1000,
    finishedAt: undefined,
    runTypes: undefined,
    ...overrides,
  };
}

function fresh(): ProgressValues {
  return emptyProgress(BATCH, EXPERIMENT, 0);
}

/** Folds a whole run lifecycle into a rollup, one transition at a time. */
function fold(
  prev: ProgressValues,
  transitions: [ProgressRun | null, ProgressRun | null][],
  now = 42,
): ProgressValues {
  let acc = prev;
  for (const [before, after] of transitions) {
    acc = applyContribution(
      acc,
      before ? runContribution(before) : null,
      after ? runContribution(after) : null,
      now,
    );
  }
  return acc;
}

describe("runContribution", () => {
  test("a pending run occupies total + pending only", () => {
    const c = runContribution(run());
    expect(c.counters).toMatchObject({
      ...zeroCounters(),
      total: 1,
      pending: 1,
    });
    expect(c.failureKey).toBeUndefined();
    expect(c.finishedAt).toBeUndefined();
  });

  test("a finished run fills the quality, timing and energy counters", () => {
    const c = runContribution(
      run({
        status: RUN_STATUS.FINISHED,
        converged: true,
        imaginaryModes: 0,
        gibbsEh: -76.4,
        lastEnergy: -76.42,
        wallclockSec: 120,
        nprocs: 8,
        finishedAt: 5000,
      }),
    );
    expect(c.counters).toMatchObject({
      total: 1,
      finished: 1,
      converged: 1,
      notConverged: 0,
      withImaginary: 0,
      missingThermo: 0,
      suspicious: 0,
      wallclockSumSec: 120,
      wallclockSumSqSec: 14400,
      coreSecondsSum: 960,
      energySumEh: -76.42,
      energyCount: 1,
    });
    expect(c.energyEh).toBe(-76.42);
    expect(c.finishedAt).toBe(5000);
  });

  test("a failed run contributes core-seconds but no duration sample", () => {
    const c = runContribution(
      run({
        status: RUN_STATUS.FAILED,
        exitCode: 1,
        wallclockSec: 60,
        ncores: 4,
        finishedAt: 5000,
      }),
    );
    // Failures die early; letting them into the duration distribution would
    // drag the ETA of the remaining work down.
    expect(c.counters.wallclockSumSec).toBe(0);
    expect(c.counters.wallclockSumSqSec).toBe(0);
    // …but they still burned the allocation.
    expect(c.counters.coreSecondsSum).toBe(240);
    expect(c.counters.suspicious).toBe(1);
    expect(c.failureKey).toBe(`${EXIT_CODE_KEY_PREFIX}1`);
  });

  test("finished without a Gibbs energy counts as missing thermo", () => {
    expect(
      runContribution(run({ status: RUN_STATUS.FINISHED, lastEnergy: -1 })).counters
        .missingThermo,
    ).toBe(1);
    expect(
      runContribution(
        run({ status: RUN_STATUS.FINISHED, lastEnergy: -1, gibbsEh: -1 }),
      ).counters.missingThermo,
    ).toBe(0);
  });

  test("an imaginary mode is only suspicious outside a TS search", () => {
    const opt = run({
      status: RUN_STATUS.FINISHED,
      lastEnergy: -1,
      gibbsEh: -1,
      imaginaryModes: 1,
      runTypes: ["Opt"],
    });
    const ts = { ...opt, runTypes: ["neb-ts"] };
    expect(runContribution(opt).counters.suspicious).toBe(1);
    expect(runContribution(ts).counters.suspicious).toBe(0);
    // Both still count as carrying an imaginary mode.
    expect(runContribution(ts).counters.withImaginary).toBe(1);
  });

  test("in-flight runs contribute no quality tallies", () => {
    const c = runContribution(
      run({ status: RUN_STATUS.RUNNING, converged: false, imaginaryModes: 2 }),
    );
    expect(c.counters.notConverged).toBe(0);
    expect(c.counters.withImaginary).toBe(0);
    expect(c.counters.suspicious).toBe(0);
    expect(c.counters.running).toBe(1);
  });
});

describe("runWallclockSec", () => {
  test("prefers ORCA's own TOTAL RUN TIME", () => {
    expect(runWallclockSec({ wallclockSec: 30, startedAt: 0, finishedAt: 999000 })).toBe(30);
  });
  test("falls back to the tracked interval", () => {
    expect(runWallclockSec({ startedAt: 1000, finishedAt: 4000 })).toBe(3);
  });
  test("is zero when neither is usable", () => {
    expect(runWallclockSec({ startedAt: 1000 })).toBe(0);
    expect(runWallclockSec({ startedAt: 4000, finishedAt: 1000 })).toBe(0);
  });
});

describe("failureKeyOf", () => {
  test("prefers the wrapper's error class", () => {
    expect(
      failureKeyOf({ errorClass: ERROR_CLASS.OUT_OF_MEMORY, exitCode: 137 }),
    ).toBe(ERROR_CLASS.OUT_OF_MEMORY);
  });
  test("falls back to the exit code when unclassified", () => {
    expect(failureKeyOf({ exitCode: 137 })).toBe(`${EXIT_CODE_KEY_PREFIX}137`);
  });
  test("falls back to unknown when there is nothing at all", () => {
    expect(failureKeyOf({})).toBe(ERROR_CLASS.UNKNOWN);
    expect(failureKeyOf({ errorClass: "  " })).toBe(ERROR_CLASS.UNKNOWN);
  });
});

describe("applyContribution — status transitions", () => {
  test("create → pending", () => {
    const p = fold(fresh(), [[null, run()]]);
    expect(p).toMatchObject({ total: 1, pending: 1, running: 0, finished: 0, failed: 0 });
    expect(p.firstStartedAt).toBe(1000);
  });

  test("pending → running → finished moves exactly one counter at a time", () => {
    const pending = run();
    const running = run({ status: RUN_STATUS.RUNNING });
    const finished = run({
      status: RUN_STATUS.FINISHED,
      converged: true,
      gibbsEh: -1,
      lastEnergy: -76,
      wallclockSec: 10,
      finishedAt: 9000,
    });
    const p = fold(fresh(), [
      [null, pending],
      [pending, running],
      [running, finished],
    ]);
    expect(p).toMatchObject({
      total: 1,
      pending: 0,
      running: 0,
      finished: 1,
      failed: 0,
      converged: 1,
      energyCount: 1,
    });
    expect(p.lastFinishedAt).toBe(9000);
    expect(p.minEnergyEh).toBe(-76);
  });

  test("a result-only patch (same status) is a no-op for the status counters", () => {
    const running = run({ status: RUN_STATUS.RUNNING });
    const withEnergy = { ...running, lastEnergy: -76.1 };
    const p = fold(fresh(), [
      [null, running],
      [running, withEnergy],
      [withEnergy, withEnergy],
    ]);
    expect(p).toMatchObject({ total: 1, running: 1, energyCount: 0 });
  });

  test("replaying the identical transition does not double-count", () => {
    const running = run({ status: RUN_STATUS.RUNNING });
    const finished = run({
      status: RUN_STATUS.FINISHED,
      lastEnergy: -5,
      gibbsEh: -5,
      wallclockSec: 4,
      finishedAt: 8000,
    });
    const once = fold(fresh(), [[null, running], [running, finished]]);
    const twice = fold(once, [[finished, finished]]);
    expect(twice).toMatchObject({
      total: once.total,
      finished: once.finished,
      energyCount: once.energyCount,
      wallclockSumSec: once.wallclockSumSec,
    });
  });

  test("failed → running (a restart) unwinds the failure bucket", () => {
    const failed = run({
      status: RUN_STATUS.FAILED,
      errorClass: ERROR_CLASS.SCF_NOT_CONVERGED,
      finishedAt: 2000,
    });
    const restarted = run({ status: RUN_STATUS.RUNNING });
    const p = fold(fresh(), [
      [null, failed],
      [failed, restarted],
    ]);
    expect(p).toMatchObject({ failed: 0, running: 1, total: 1, suspicious: 0 });
    expect(p.failureCounts).toEqual({});
  });

  test("a reclassified failure moves between buckets without changing the total", () => {
    const unclassified = run({ status: RUN_STATUS.FAILED, exitCode: 137 });
    const classified = { ...unclassified, errorClass: ERROR_CLASS.OUT_OF_MEMORY };
    const p = fold(fresh(), [
      [null, unclassified],
      [unclassified, classified],
    ]);
    expect(p.failed).toBe(1);
    expect(p.failureCounts).toEqual({ [ERROR_CLASS.OUT_OF_MEMORY]: 1 });
  });

  test("deleting a run takes its whole contribution back out", () => {
    const finished = run({
      status: RUN_STATUS.FINISHED,
      converged: true,
      gibbsEh: -1,
      lastEnergy: -9,
      wallclockSec: 6,
      nprocs: 2,
      finishedAt: 7000,
    });
    const p = fold(fresh(), [
      [null, finished],
      [finished, null],
    ]);
    expect(p).toMatchObject({
      total: 0,
      finished: 0,
      converged: 0,
      energyCount: 0,
      energySumEh: 0,
      wallclockSumSec: 0,
      coreSecondsSum: 0,
    });
    // The extremes are monotone by design — the backfill migration is what
    // recomputes them exactly.
    expect(p.minEnergyEh).toBe(-9);
  });

  test("a removal on its own is a negative delta — the merge clamps, not this", () => {
    const running = run({ status: RUN_STATUS.RUNNING });
    const delta = fold(fresh(), [[running, null]]);
    // A run write appends its delta without reading the other rows, so a
    // standalone "run left the batch" row is legitimately negative.
    expect(delta.total).toBe(-1);
    expect(delta.running).toBe(-1);
    expect(mergeProgress(BATCH, EXPERIMENT, [delta]).total).toBe(0);
  });

  test("energy sums stay signed (Hartrees are negative)", () => {
    const a = run({ status: RUN_STATUS.FINISHED, lastEnergy: -76.4, gibbsEh: -1 });
    const b = run({ status: RUN_STATUS.FINISHED, lastEnergy: -76.6, gibbsEh: -1 });
    const p = fold(fresh(), [
      [null, a],
      [null, b],
    ]);
    expect(p.energySumEh).toBeCloseTo(-153, 6);
    expect(p.energyCount).toBe(2);
    expect(p.minEnergyEh).toBe(-76.6);
  });

  test("firstStartedAt is the earliest and lastFinishedAt the latest", () => {
    const early = run({ status: RUN_STATUS.FINISHED, startedAt: 500, finishedAt: 900, gibbsEh: -1, lastEnergy: -1 });
    const late = run({ status: RUN_STATUS.FINISHED, startedAt: 5000, finishedAt: 9000, gibbsEh: -1, lastEnergy: -1 });
    const p = fold(fresh(), [
      [null, late],
      [null, early],
    ]);
    expect(p.firstStartedAt).toBe(500);
    expect(p.lastFinishedAt).toBe(9000);
  });

  test("stamps updatedAt on every fold", () => {
    const p = applyContribution(fresh(), null, runContribution(run()), 12345);
    expect(p.updatedAt).toBe(12345);
  });
});

describe("sumProgress / mergeProgress", () => {
  /** One appended delta row per transition, exactly as the writer stores them. */
  function deltas(transitions: [ProgressRun | null, ProgressRun | null][]) {
    return transitions.map(([before, after]) => fold(fresh(), [[before, after]]));
  }

  test("summing the rows of a lifecycle equals folding it in place", () => {
    const pending = run();
    const running = run({ status: RUN_STATUS.RUNNING });
    const finished = run({
      status: RUN_STATUS.FINISHED,
      converged: true,
      gibbsEh: -1,
      lastEnergy: -12,
      wallclockSec: 9,
      nprocs: 3,
      finishedAt: 8000,
    });
    const transitions: [ProgressRun | null, ProgressRun | null][] = [
      [null, pending],
      [pending, running],
      [running, finished],
    ];
    const inPlace = fold(fresh(), transitions);
    const summed = mergeProgress(BATCH, EXPERIMENT, deltas(transitions));
    expect(summed.total).toBe(inPlace.total);
    expect(summed.finished).toBe(inPlace.finished);
    expect(summed.pending).toBe(inPlace.pending);
    expect(summed.energySumEh).toBeCloseTo(inPlace.energySumEh, 9);
    expect(summed.coreSecondsSum).toBe(inPlace.coreSecondsSum);
    expect(summed.minEnergyEh).toBe(inPlace.minEnergyEh);
    expect(summed.lastFinishedAt).toBe(inPlace.lastFinishedAt);
  });

  test("order does not matter — the rows are a commutative sum", () => {
    const a = run({ status: RUN_STATUS.FAILED, errorClass: ERROR_CLASS.INPUT_ERROR });
    const b = run({ status: RUN_STATUS.RUNNING });
    const rows = deltas([
      [null, a],
      [null, b],
      [a, null],
    ]);
    const forward = mergeProgress(BATCH, EXPERIMENT, rows);
    const backward = mergeProgress(BATCH, EXPERIMENT, [...rows].reverse());
    expect(forward).toEqual(backward);
    expect(forward.failed).toBe(0);
    expect(forward.running).toBe(1);
    expect(forward.failureCounts).toEqual({});
  });

  test("compaction of a subset keeps negatives; the whole sum clamps", () => {
    const running = run({ status: RUN_STATUS.RUNNING });
    const [added, removed] = deltas([
      [null, running],
      [running, null],
    ]);
    // Compaction can fold the removal before the addition.
    const partial = sumProgress(BATCH, EXPERIMENT, [removed!]);
    expect(partial.running).toBe(-1);
    // …and the batch total is still right afterwards.
    expect(mergeProgress(BATCH, EXPERIMENT, [partial, added!]).running).toBe(0);
  });

  test("an empty rollup merges to all zeroes", () => {
    expect(mergeProgress(BATCH, EXPERIMENT, [])).toMatchObject({
      ...zeroCounters(),
      batchId: BATCH,
      experimentId: EXPERIMENT,
      failureCounts: {},
    });
  });
});

describe("projectBatchRow", () => {
  const doc = {
    _id: "run1" as Id<"runs">,
    _creationTime: 1,
    experimentId: EXPERIMENT,
    batchId: BATCH,
    status: RUN_STATUS.FINISHED,
    startedAt: 1000,
    finishedAt: 2000,
    name: "conf-17",
    inputText: "! B3LYP def2-SVP Opt\n*xyz 0 1\nH 0 0 0\n*\n",
    notes: "a long lab note",
    lastEnergy: -76.4,
    batchParams: { solvent: "water" },
  } as unknown as Doc<"runs">;

  test("never carries inputText — a whole ORCA input per row", () => {
    const row = projectBatchRow(doc);
    expect("inputText" in row).toBe(false);
    expect(JSON.stringify(row)).not.toContain("B3LYP def2-SVP Opt");
  });

  test("carries what the dense table, its filters and its exports read", () => {
    expect(projectBatchRow(doc)).toMatchObject({
      _id: doc._id,
      name: "conf-17",
      status: RUN_STATUS.FINISHED,
      startedAt: 1000,
      finishedAt: 2000,
      lastEnergy: -76.4,
      batchParams: { solvent: "water" },
    });
  });
});

describe("isZeroContributionChange", () => {
  const finished = run({
    status: RUN_STATUS.FINISHED,
    lastEnergy: -10,
    gibbsEh: -9,
    wallclockSec: 5,
    finishedAt: 2000,
  });

  test("an identical replay changes nothing", () => {
    expect(
      isZeroContributionChange(runContribution(finished), runContribution({ ...finished })),
    ).toBe(true);
  });

  test("a status move is a change", () => {
    expect(
      isZeroContributionChange(
        runContribution(run()),
        runContribution(run({ status: RUN_STATUS.RUNNING })),
      ),
    ).toBe(false);
  });

  test("a moved extreme is a change even when every counter is equal", () => {
    // wallclockSec is explicit, so a new finish time moves no counter — but the
    // batch's lastFinishedAt must still hear about it.
    expect(
      isZeroContributionChange(
        runContribution(finished),
        runContribution({ ...finished, finishedAt: 3000 }),
      ),
    ).toBe(false);
  });

  test("a reclassified failure is a change", () => {
    const failed = run({ status: RUN_STATUS.FAILED, errorClass: ERROR_CLASS.OUT_OF_MEMORY });
    expect(
      isZeroContributionChange(
        runContribution(failed),
        runContribution({ ...failed, errorClass: ERROR_CLASS.INPUT_ERROR }),
      ),
    ).toBe(false);
  });
});
