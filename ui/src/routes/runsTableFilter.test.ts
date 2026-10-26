import { test, expect } from "bun:test";
import type { Run } from "../data/types";
import { filterRuns } from "./runsTableFilter";

function mkRun(partial: Partial<Run> & { id: string }): Run {
  return {
    experimentId: "exp1",
    status: "finished",
    startedAt: 0,
    ...partial,
  };
}

const runs: Run[] = [
  mkRun({
    id: "r1",
    name: "water-opt",
    functional: "B3LYP",
    basis: "def2-SVP",
    keywords: ["D3BJ", "TightSCF"],
    runTypes: ["Opt", "Freq"],
    submittedBy: "florian",
  }),
  mkRun({
    id: "r2",
    name: "benzene-sp",
    method: "DLPNO-CCSD(T)",
    basis: "cc-pVTZ",
    solvent: "toluene",
    submittedBy: "mtran",
  }),
  mkRun({ id: "r3" }),
];

test("empty or whitespace query returns the input array untouched", () => {
  expect(filterRuns(runs, "")).toBe(runs);
  expect(filterRuns(runs, "   ")).toBe(runs);
});

test("matches name case-insensitively", () => {
  expect(filterRuns(runs, "WATER").map((r) => r.id)).toEqual(["r1"]);
});

test("matches method and functional", () => {
  expect(filterRuns(runs, "dlpno").map((r) => r.id)).toEqual(["r2"]);
  expect(filterRuns(runs, "b3lyp").map((r) => r.id)).toEqual(["r1"]);
});

test("matches basis, solvent and submitter", () => {
  expect(filterRuns(runs, "cc-pvtz").map((r) => r.id)).toEqual(["r2"]);
  expect(filterRuns(runs, "toluene").map((r) => r.id)).toEqual(["r2"]);
  expect(filterRuns(runs, "florian").map((r) => r.id)).toEqual(["r1"]);
});

test("matches keywords and run types", () => {
  expect(filterRuns(runs, "tightscf").map((r) => r.id)).toEqual(["r1"]);
  expect(filterRuns(runs, "freq").map((r) => r.id)).toEqual(["r1"]);
});

test("query is trimmed before matching", () => {
  expect(filterRuns(runs, "  benzene ").map((r) => r.id)).toEqual(["r2"]);
});

test("runs with no metadata never match a non-empty query", () => {
  expect(filterRuns(runs, "zzz")).toEqual([]);
});
