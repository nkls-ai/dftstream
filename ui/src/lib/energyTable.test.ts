import { test, expect } from "bun:test";
import { EH_TO_KCAL } from "./constants";
import type { Run } from "../data/types";
import { classifyRun, energyCSV, energyRows } from "./energyTable";

function run(partial: Partial<Run>): Run {
  return {
    id: partial.id ?? "r1",
    experimentId: "e1",
    status: partial.status ?? "finished",
    startedAt: 0,
    ...partial,
  } as Run;
}

test("classifyRun: clean minimum is OK", () => {
  expect(classifyRun(run({ runTypes: ["OPT", "FREQ"], converged: true, imaginaryModes: 0 }))).toBe("OK");
});

test("classifyRun: minimum with imaginary modes is IMAG", () => {
  expect(classifyRun(run({ runTypes: ["OPT", "FREQ"], converged: true, imaginaryModes: 1 }))).toBe("IMAG");
});

test("classifyRun: OptTS with exactly one imaginary mode is OK", () => {
  expect(classifyRun(run({ runTypes: ["OPTTS", "FREQ"], converged: true, imaginaryModes: 1 }))).toBe("OK");
  expect(classifyRun(run({ runTypes: ["OPTTS", "FREQ"], converged: true, imaginaryModes: 0 }))).toBe("IMAG");
  expect(classifyRun(run({ runTypes: ["OPTTS", "FREQ"], converged: true, imaginaryModes: 2 }))).toBe("IMAG");
});

test("classifyRun: converged opt that died later is FREQ_BROKE", () => {
  expect(classifyRun(run({ status: "failed", runTypes: ["OPT", "FREQ"], converged: true }))).toBe("FREQ_BROKE");
});

test("classifyRun: unconverged opt is OPT_BROKE, crashed or finished", () => {
  expect(classifyRun(run({ status: "failed", runTypes: ["OPT"], converged: false }))).toBe("OPT_BROKE");
  expect(classifyRun(run({ status: "finished", runTypes: ["OPT"], converged: false }))).toBe("OPT_BROKE");
});

test("classifyRun: failed non-opt is FAILED; live runs are RUNNING", () => {
  expect(classifyRun(run({ status: "failed", runTypes: ["SP"] }))).toBe("FAILED");
  expect(classifyRun(run({ status: "running" }))).toBe("RUNNING");
  expect(classifyRun(run({ status: "pending" }))).toBe("RUNNING");
});

test("energyRows: relative energies against the lowest finite value per column", () => {
  const rows = energyRows([
    run({ id: "a", lastEnergy: -100.0, gibbsEh: -99.9 }),
    run({ id: "b", lastEnergy: -100.1, gibbsEh: -100.0 }),
    run({ id: "c" }),
  ]);
  const a = rows.find((r) => r.run.id === "a")!;
  const b = rows.find((r) => r.run.id === "b")!;
  const c = rows.find((r) => r.run.id === "c")!;
  expect(b.relEEh).toBeCloseTo(0, 8);
  expect(a.relEEh!).toBeCloseTo(0.1, 6);
  expect(b.relGEh).toBeCloseTo(0, 8);
  expect(a.relGEh!).toBeCloseTo(0.1, 6);
  expect(c.relEEh).toBeUndefined();
  expect(c.relGEh).toBeUndefined();
  // Sorted by ΔG: b first, missing-energy last.
  expect(rows[0]!.run.id).toBe("b");
  expect(rows[2]!.run.id).toBe("c");
});

test("energyCSV: header plus one row per run, Hartrees at 8 decimals", () => {
  const csv = energyCSV(
    energyRows([run({ id: "a", name: "ts1", jobType: "OPTTS_FREQ", lastEnergy: -100.123456789, gibbsEh: -100.1, gMinusEEh: 0.0234 })]),
    "kcal",
  );
  const [header, row] = csv.split("\n");
  expect(header).toContain("gibbs_eh");
  expect(header).toContain("rel_g_kcal");
  expect(row).toContain("ts1");
  expect(row).toContain("-100.12345679");
  expect(row).toContain("0.02340000");
});

test("energyCSV: relative columns follow the selected unit", () => {
  const rows = energyRows([
    run({ id: "a", lastEnergy: -100.0 }),
    run({ id: "b", lastEnergy: -100.1 }),
  ]);
  const kcalCsv = energyCSV(rows, "kcal");
  expect(kcalCsv.split("\n")[0]).toContain("rel_e_kcal");
  const aRow = kcalCsv.split("\n").find((l) => l.startsWith("a"))!;
  expect(aRow).toContain((0.1 * EH_TO_KCAL).toFixed(4));

  const ehCsv = energyCSV(rows, "eh");
  expect(ehCsv.split("\n")[0]).toContain("rel_e_eh");
  expect(ehCsv.split("\n").find((l) => l.startsWith("a"))!).toContain("0.10000000");
});
