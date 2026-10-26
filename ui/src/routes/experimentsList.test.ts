import { test, expect } from "bun:test";
import type { ExperimentSummary } from "../data/types";
import { filterExperiments, sortExperiments } from "./experimentsList";

function mkExp(
  partial: Partial<ExperimentSummary> & { id: string; name: string },
): ExperimentSummary {
  return {
    createdAt: 0,
    runCount: 0,
    running: 0,
    finished: 0,
    failed: 0,
    lastActivity: 0,
    ...partial,
  };
}

const exps: ExperimentSummary[] = [
  mkExp({ id: "e1", name: "Catalysis screen", runCount: 12, lastActivity: 300 }),
  mkExp({ id: "e2", name: "benzene benchmark", runCount: 40, lastActivity: 100 }),
  mkExp({ id: "e3", name: "Aldol TS search", runCount: 5, lastActivity: 200 }),
];

test("filterExperiments: empty or whitespace query returns input untouched", () => {
  expect(filterExperiments(exps, "")).toBe(exps);
  expect(filterExperiments(exps, "  ")).toBe(exps);
});

test("filterExperiments matches name case-insensitively and trims", () => {
  expect(filterExperiments(exps, "BENZ").map((e) => e.id)).toEqual(["e2"]);
  expect(filterExperiments(exps, " ts ").map((e) => e.id)).toEqual(["e3"]);
  expect(filterExperiments(exps, "nope")).toEqual([]);
});

test("sortExperiments: newest keeps the server order and identity", () => {
  expect(sortExperiments(exps, "newest")).toBe(exps);
});

test("sortExperiments: name sorts A-Z case-insensitively without mutating input", () => {
  const before = [...exps];
  expect(sortExperiments(exps, "name").map((e) => e.id)).toEqual(["e3", "e2", "e1"]);
  expect(exps).toEqual(before);
});

test("sortExperiments: runs sorts by run count descending", () => {
  expect(sortExperiments(exps, "runs").map((e) => e.id)).toEqual(["e2", "e1", "e3"]);
});

test("sortExperiments: activity sorts by lastActivity descending", () => {
  expect(sortExperiments(exps, "activity").map((e) => e.id)).toEqual(["e1", "e3", "e2"]);
});
