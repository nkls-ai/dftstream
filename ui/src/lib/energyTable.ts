import type { Run } from "../data/types";
import { csvCell } from "./batchStats";
import { ehTo, type EnergyUnit } from "./energyUnits";
import { isActiveStatus, isOptimizationRun, isTSSearchRun } from "./convergence";
import { gMinusElectronicEh } from "./thermo";

// Success matrix for a run, following the classification our group already
// uses for resubmission triage:
//   OK         — finished, converged, clean spectrum (or valid TS)
//   IMAG       — finished but the imaginary-mode count is wrong for the job
//                (minimum with imaginary modes, or OptTS without exactly one)
//   FREQ_BROKE — the optimization converged but the run died afterwards
//                (typically in the frequency step) — geometry is usable
//   OPT_BROKE  — the optimizer never converged (crashed or hit max cycles)
//   FAILED     — non-optimization run that died
//   RUNNING    — still in flight
export type RunResult = "OK" | "IMAG" | "FREQ_BROKE" | "OPT_BROKE" | "FAILED" | "RUNNING";

export function classifyRun(r: Run): RunResult {
  if (isActiveStatus(r.status)) return "RUNNING";
  const isOpt = isOptimizationRun(r);
  const isTS = isTSSearchRun(r);
  if (r.status === "failed") {
    if (isOpt && r.converged === true) return "FREQ_BROKE";
    return isOpt ? "OPT_BROKE" : "FAILED";
  }
  if (isOpt && r.converged === false) return "OPT_BROKE";
  const imag = r.imaginaryModes;
  if (imag != null && (isTS ? imag !== 1 : imag > 0)) return "IMAG";
  return "OK";
}

// One row of the cross-run energy comparison. Relative energies are in
// Hartree against the lowest finite value of the same column across the
// run set (converted to the user's unit at display/export time), so rows
// lacking a value can't poison the scale.
export interface EnergyRow {
  run: Run;
  result: RunResult;
  relEEh?: number;
  relGEh?: number;
}

export function energyRows(runs: Run[]): EnergyRow[] {
  const finiteMin = (vals: (number | undefined)[]): number | null => {
    const xs = vals.filter((x): x is number => x != null && Number.isFinite(x));
    return xs.length > 0 ? Math.min(...xs) : null;
  };
  const minE = finiteMin(runs.map((r) => r.lastEnergy));
  const minG = finiteMin(runs.map((r) => r.gibbsEh));
  return runs
    .map((run) => ({
      run,
      result: classifyRun(run),
      relEEh:
        run.lastEnergy != null && minE != null
          ? run.lastEnergy - minE
          : undefined,
      relGEh:
        run.gibbsEh != null && minG != null
          ? run.gibbsEh - minG
          : undefined,
    }))
    .sort(
      (a, b) =>
        (a.relGEh ?? a.relEEh ?? Number.POSITIVE_INFINITY) -
        (b.relGEh ?? b.relEEh ?? Number.POSITIVE_INFINITY),
    );
}

export function energyExportColumns(unit: EnergyUnit): string[] {
  return [
    "name",
    "job_type",
    "result",
    "status",
    "converged",
    "imaginary_modes",
    "energy_eh",
    `rel_e_${unit}`,
    "gibbs_eh",
    `rel_g_${unit}`,
    "g_minus_e_eh",
    "zpe_eh",
    "enthalpy_eh",
    "entropy_corr_eh",
    "wallclock_s",
  ];
}

function energyExportRow(row: EnergyRow, unit: EnergyUnit): string[] {
  const r = row.run;
  // 8 decimals is the meaningful precision for Hartree energies.
  const eh = (v?: number) => (v != null ? v.toFixed(8) : "");
  // Relative values carry more decimals in the export than on screen so
  // spreadsheet round-trips don't lose precision.
  const rel = (v?: number) =>
    v != null ? ehTo(unit, v).toFixed(unit === "eh" ? 8 : 4) : "";
  return [
    r.name ?? r.id,
    r.jobType ?? "",
    row.result,
    r.status,
    r.converged == null ? "" : String(r.converged),
    r.imaginaryModes != null ? String(r.imaginaryModes) : "",
    eh(r.lastEnergy),
    rel(row.relEEh),
    eh(r.gibbsEh),
    rel(row.relGEh),
    eh(gMinusElectronicEh(r)),
    eh(r.zpeEh),
    eh(r.enthalpyEh),
    eh(r.entropyCorrEh),
    r.wallclockSec != null ? String(r.wallclockSec) : "",
  ];
}

export function energyCSV(rows: readonly EnergyRow[], unit: EnergyUnit): string {
  const lines = [energyExportColumns(unit).join(",")];
  for (const row of rows) lines.push(energyExportRow(row, unit).map(csvCell).join(","));
  return lines.join("\n");
}
