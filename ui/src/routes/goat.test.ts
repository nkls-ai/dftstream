import { describe, expect, test } from "bun:test";
import {
  goatEnsembleCSV,
  mergeGoatConformerXYZ,
  parseGoatOutput,
  withBoltzmannPopulations,
  type GoatConformer,
} from "./goat";

const goatOutput = `
  GOAT version                               ... entropy
  Final number of workers                    ... 8
  Ensemble temperature                       ... 298.15 K

\t\t     GOAT Global Iter 3
\t\tIter    Min En       Sconf       Gconf
\t\t   1    -27.366321   1.542       -0.376
\t\t   2    -27.366324   1.542       -0.375
\t\t   3    -27.366325   1.543       -0.366

\t\t# Final ensemble info #
\t\tConformer     Energy     Degen.   % total   % cumul.
\t\t        0     0.000      4      53.87      53.87
\t\t        1     0.120      4      44.00      97.87
\t\t        2     1.914      4       2.13     100.00

\t\tConformers below 3 kcal/mol: 3
\t\tLowest energy conformer    : -27.366325 Eh
\t\tSconf at 298.15 K          :  1.54 cal/(molK)
\t\tGconf at 298.15 K          : -0.37 kcal/mol
`;

describe("GOAT parsing", () => {
  test("ignores MO-energy rows that share the iteration-row shape", () => {
    const withOrbitals = `
  GOAT version                               ... entropy
  NO   OCC          E(Eh)            E(eV)
   1   2.0000       -0.7037757       -19.1507
  24   2.0000       -0.4122015       -11.2166
${goatOutput}`;
    const summary = parseGoatOutput(withOrbitals);
    expect(summary?.iterations.map((i) => i.iter)).toEqual([1, 2, 3]);
    expect(summary?.iterations.every((i) => i.minEnergyEh < -27)).toBe(true);
  });

  test("real GOAT output yields only the global-iteration minima", async () => {
    const file = Bun.file(`${import.meta.dir}/../../../.examples/goat_ma1_xtb/goat_ma1_xtb.out`);
    if (!(await file.exists())) return; // example data is optional in CI checkouts
    const summary = parseGoatOutput(await file.text());
    expect(summary?.iterations.map((i) => i.iter)).toEqual([1, 2, 3]);
    expect(summary?.iterations[0]?.minEnergyEh).toBe(-27.366321);
  });

  test("extracts convergence and final ensemble rows", () => {
    const summary = parseGoatOutput(goatOutput);
    expect(summary?.version).toBe("entropy");
    expect(summary?.finalWorkers).toBe(8);
    expect(summary?.iterations).toHaveLength(3);
    expect(summary?.iterations[2]?.gconfKcalMol).toBe(-0.366);
    expect(summary?.conformers).toHaveLength(3);
    expect(summary?.conformers[1]?.percentTotal).toBe(44);
    expect(summary?.lowestEnergyEh).toBe(-27.366325);
  });

  test("merges final ensemble xyz frames", () => {
    const summary = parseGoatOutput(goatOutput);
    const merged = mergeGoatConformerXYZ(summary, `2
-27.366325 converged=true
H 0 0 0
H 0 0 1
2
-27.366133 converged=true
H 0 0 0
H 0 0 2
`);
    expect(merged).toHaveLength(3);
    expect(merged[0]?.absoluteEnergyEh).toBe(-27.366325);
    expect(merged[1]?.xyz).toContain("H 0 0 2");
  });
});

describe("Boltzmann populations", () => {
  test("equal energies split evenly", () => {
    const out = withBoltzmannPopulations([
      { index: 0, relativeEnergyKcalMol: 0 },
      { index: 1, relativeEnergyKcalMol: 0 },
    ]);
    expect(out[0]?.percentTotal).toBeCloseTo(50, 6);
    expect(out[1]?.percentCumulative).toBeCloseTo(100, 6);
  });

  test("a kT gap at 298.15 K gives an e-fold ratio", () => {
    const kT = 0.0019872041 * 298.15;
    const out = withBoltzmannPopulations([
      { index: 0, relativeEnergyKcalMol: 0 },
      { index: 1, relativeEnergyKcalMol: kT },
    ]);
    expect(out[0]!.percentTotal! / out[1]!.percentTotal!).toBeCloseTo(Math.E, 6);
  });

  test("respects degeneracy and never overwrites ORCA-reported values", () => {
    const degenerate = withBoltzmannPopulations([
      { index: 0, relativeEnergyKcalMol: 0, degeneracy: 2 },
      { index: 1, relativeEnergyKcalMol: 0, degeneracy: 1 },
    ]);
    expect(degenerate[0]?.percentTotal).toBeCloseTo(66.6667, 3);

    const orca: GoatConformer[] = [
      { index: 0, relativeEnergyKcalMol: 0, percentTotal: 90 },
      { index: 1, relativeEnergyKcalMol: 5 },
    ];
    expect(withBoltzmannPopulations(orca)).toBe(orca);
  });

  test("ensemble xyz alone yields ranked conformers with populations and CSV", () => {
    const xyz = [
      "2",
      "-27.366325 converged=true",
      "H 0 0 0",
      "H 0 0 1",
      "2",
      "-27.360000 converged=true",
      "H 0 0 0",
      "H 0 0 2",
      "",
    ].join("\n");
    const confs = withBoltzmannPopulations(mergeGoatConformerXYZ(null, xyz));
    expect(confs).toHaveLength(2);
    expect(confs[0]?.relativeEnergyKcalMol).toBeCloseTo(0, 6);
    expect(confs[0]!.percentTotal!).toBeGreaterThan(confs[1]!.percentTotal!);
    const csv = goatEnsembleCSV(confs);
    expect(csv.split("\n")[0]).toBe(
      "conformer,energy_eh,rel_kcal,degeneracy,pop_percent,cumulative_percent",
    );
    expect(csv).toContain("-27.36632500");
  });
});
