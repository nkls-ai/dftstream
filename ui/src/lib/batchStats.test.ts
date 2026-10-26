import { test, expect } from "bun:test";
import type { Run } from "../data/types";
import {
  computeBatchStats,
  failureExamplesByKey,
  groupFailures,
  isSuspicious,
  matchesFilter,
  rankRuns,
  toCSV,
  toMarkdown,
} from "./batchStats";

function run(partial: Partial<Run>): Run {
  return {
    id: partial.id ?? "r1",
    experimentId: "e1",
    status: partial.status ?? "finished",
    startedAt: 0,
    ...partial,
  } as Run;
}

test("computeBatchStats counts each bucket", () => {
  const runs = [
    run({ id: "a", status: "finished", lastEnergy: -1, converged: true }),
    run({ id: "b", status: "running" }),
    run({ id: "c", status: "failed", exitCode: 1 }),
    run({ id: "d", status: "finished", converged: false }),
  ];
  const s = computeBatchStats(runs);
  expect(s.total).toBe(4);
  expect(s.running).toBe(1);
  expect(s.finished).toBe(2);
  expect(s.failed).toBe(1);
  expect(s.notConverged).toBe(1);
  // failed (c) + not-converged finished (d) are both suspicious.
  expect(s.suspicious).toBe(2);
});

test("a finished run with no energy is suspicious", () => {
  expect(computeBatchStats([run({ status: "finished" })]).suspicious).toBe(1);
});

test("pending runs count toward running", () => {
  expect(computeBatchStats([run({ status: "pending" })]).running).toBe(1);
});

test("rankRuns computes relative energy from the lowest finite energy", () => {
  const ranked = rankRuns([
    run({ id: "hi", lastEnergy: -100.0 }),
    run({ id: "lo", lastEnergy: -100.1 }),
    run({ id: "none" }),
  ]);
  const lo = ranked.find((r) => r.id === "lo")!;
  const hi = ranked.find((r) => r.id === "hi")!;
  const none = ranked.find((r) => r.id === "none")!;
  expect(lo.relativeKcal).toBeCloseTo(0, 6);
  expect(hi.relativeKcal!).toBeCloseTo(0.1 * 627.509474, 4);
  expect(none.relativeKcal).toBeUndefined();
});

test("rankRuns ignores a non-finite energy when picking the reference", () => {
  const ranked = rankRuns([
    run({ id: "nan", lastEnergy: Number.NaN }),
    run({ id: "real", lastEnergy: -50 }),
  ]);
  expect(ranked.find((r) => r.id === "real")!.relativeKcal).toBeCloseTo(0, 6);
});

test("rankRuns orders failed → running → pending → finished, then by energy", () => {
  const ranked = rankRuns([
    run({ id: "fin-hi", status: "finished", lastEnergy: -1 }),
    run({ id: "fin-lo", status: "finished", lastEnergy: -2 }),
    run({ id: "fail", status: "failed" }),
    run({ id: "runn", status: "running" }),
  ]);
  expect(ranked.map((r) => r.id)).toEqual(["fail", "runn", "fin-lo", "fin-hi"]);
});

test("isSuspicious flags a positive imaginary count on a non-TS run", () => {
  expect(isSuspicious(run({ status: "finished", lastEnergy: -1, imaginaryModes: 1 }))).toBe(true);
  // ...but not on an OptTS run, where one imaginary mode is expected.
  expect(
    isSuspicious(run({ status: "finished", lastEnergy: -1, imaginaryModes: 1, runTypes: ["OPTTS"] })),
  ).toBe(false);
});

// Regression: isSuspicious used isOptTSRun, which matches only the literal
// OPTTS keyword. A NEB-TS batch — where a converged run ending in exactly one
// imaginary mode is the textbook success — had every such row highlighted as
// suspicious and selected by the "suspicious" filter, while the tile above
// (fed by the backend rollup, which uses isTSSearchRun) read 0.
test("isSuspicious does not flag the NEB-TS variants for their expected imaginary mode", () => {
  for (const runTypes of [["NEB-TS"], ["ZOOM-NEB-TS"], ["OPTTS"], ["NEB-TS", "FREQ"]]) {
    expect(
      isSuspicious(run({ status: "finished", lastEnergy: -1, imaginaryModes: 1, runTypes })),
    ).toBe(false);
  }
});

test("isSuspicious agrees with the backend rollup on TS searches", () => {
  // db/convex/lib/batchSummary.ts isSuspicious: imaginaryModes > 0 &&
  // !isTSSearchRun. A TS search is never flagged on the imaginary count, at
  // any count — the tile and the rows have to say the same thing.
  for (const imaginaryModes of [0, 1, 2, 3]) {
    expect(
      isSuspicious(
        run({ status: "finished", lastEnergy: -1, imaginaryModes, runTypes: ["NEB-TS"] }),
      ),
    ).toBe(false);
  }
  // A plain minimization is still flagged for any imaginary mode.
  expect(
    isSuspicious(run({ status: "finished", lastEnergy: -1, imaginaryModes: 1, runTypes: ["OPT"] })),
  ).toBe(true);
});

test("matchesFilter handles running/pending and suspicious", () => {
  const pending = run({ status: "pending" });
  expect(matchesFilter(pending, "running")).toBe(true);
  expect(matchesFilter(pending, "finished")).toBe(false);
  expect(matchesFilter(run({ status: "failed" }), "suspicious")).toBe(true);
  expect(matchesFilter(run({ status: "finished", lastEnergy: -1 }), "all")).toBe(true);
});

test("notconverged filter matches only runs that explicitly did not converge", () => {
  expect(matchesFilter(run({ status: "finished", converged: false }), "notconverged")).toBe(true);
  expect(matchesFilter(run({ status: "finished", converged: true }), "notconverged")).toBe(false);
  // unknown convergence (undefined) is not "not converged".
  expect(matchesFilter(run({ status: "running" }), "notconverged")).toBe(false);
});

test("groupFailures buckets by exit code, most common first, with the first run as example", () => {
  const groups = groupFailures([
    run({ id: "a", status: "failed", exitCode: 1 }),
    run({ id: "b", status: "failed", exitCode: 1 }),
    run({ id: "c", status: "failed", exitCode: 9 }),
    run({ id: "d", status: "failed" }),
    run({ id: "e", status: "finished", lastEnergy: -1 }),
  ]);
  expect(groups[0]).toEqual({ signature: "exit code 1", count: 2, exampleRunId: "a" });
  expect(groups).toContainEqual({ signature: "exit code 9", count: 1, exampleRunId: "c" });
  expect(groups).toContainEqual({ signature: "failed (no exit code)", count: 1, exampleRunId: "d" });
});

test("failureExamplesByKey keys like the rollup and keeps the first run per bucket", () => {
  const examples = failureExamplesByKey([
    run({ id: "a", status: "failed", errorClass: "out_of_memory", exitCode: 137 }),
    run({ id: "b", status: "failed", errorClass: "out_of_memory" }),
    run({ id: "c", status: "failed", exitCode: 1 }),
    run({ id: "d", status: "failed" }),
    run({ id: "e", status: "finished" }),
  ]);
  // Class beats exit code — same precedence as failureKeyOf in
  // db/convex/lib/batchSummary.ts.
  expect(examples.get("out_of_memory")).toBe("a");
  expect(examples.get("exit:1")).toBe("c");
  expect(examples.get("unknown")).toBe("d");
  expect(examples.size).toBe(3);
});

test("toCSV emits a header and RFC-4180-quotes risky cells", () => {
  const csv = toCSV(rankRuns([run({ id: "x", name: "a,b", status: "finished", lastEnergy: -1 })]));
  const lines = csv.split("\n");
  expect(lines[0]?.startsWith("name,status,method")).toBe(true);
  expect(lines[1]?.startsWith('"a,b",finished')).toBe(true);
});

test("toCSV doubles embedded quotes", () => {
  const csv = toCSV(rankRuns([run({ id: "x", name: 'he said "hi"', status: "finished" })]));
  expect(csv.split("\n")[1]).toContain('"he said ""hi"""');
});

test("toMarkdown produces a titled table with a separator row", () => {
  const md = toMarkdown("ligand-screen", rankRuns([run({ id: "x", name: "mol1", status: "finished" })]));
  expect(md).toContain("# Batch: ligand-screen");
  expect(md).toContain("| name | status | method");
  expect(md).toContain("| --- |");
  expect(md).toContain("| mol1 | finished |");
});

test("toMarkdown escapes pipes in cell values", () => {
  const md = toMarkdown("b", rankRuns([run({ id: "x", name: "a|b", status: "finished" })]));
  expect(md).toContain("a\\|b");
});
