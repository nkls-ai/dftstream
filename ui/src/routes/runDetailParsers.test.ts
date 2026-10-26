import { describe, expect, test } from "bun:test";
import type { Run } from "../data/types";
import { HARTREE_TO_KCAL } from "../lib/constants";
import {
  extractCubeCycle,
  extractHessianIndex,
  extractMOIndex,
  extractVibModeIndex,
  mergeRunThermo,
  parseOutProperties,
  parseThermo,
} from "./runDetailParsers";

const THERMO_OUT = `
--------------------------
THERMOCHEMISTRY AT 298.15K
--------------------------
Electronic energy                ...    -76.32642100 Eh
Zero point energy                ...      0.02114500 Eh      13.27 kcal/mol
Total thermal energy                    -76.30238400 Eh
Total enthalpy                   ...    -76.30144000 Eh
Total entropy correction         ...     -0.02143800 Eh     -13.45 kcal/mol
Final Gibbs free energy          ...    -76.32287800 Eh
G-E(el)                          ...      0.00354300 Eh       2.22 kcal/mol
Total correction                          0.02403700 Eh      15.08 kcal/mol
`;

// Correction/entropy detail rows in ORCA's real layout.
const THERMO_DETAIL = `
Temperature         ...   298.15 K
Pressure            ...     1.00 atm
Quasi RRHO          ...     True
Thermal vibrational correction   ...      0.01523103 Eh       9.56 kcal/mol
Thermal rotational correction    ...      0.00141627 Eh       0.89 kcal/mol
Thermal translational correction ...      0.00141627 Eh       0.89 kcal/mol
Total thermal correction                  0.01806358 Eh      11.34 kcal/mol
Thermal Enthalpy correction       ...      0.00094421 Eh       0.59 kcal/mol
Electronic entropy                ...      0.00065446 Eh      0.41 kcal/mol
Vibrational entropy               ...      0.02720226 Eh     17.07 kcal/mol
Rotational entropy                ...      0.01599066 Eh     10.03 kcal/mol
Translational entropy             ...      0.02044720 Eh     12.83 kcal/mol
Final entropy term                ...      0.06429457 Eh     40.35 kcal/mol
`;

describe("parseThermo", () => {
  test("extracts every field from a THERMOCHEMISTRY block", () => {
    const t = parseThermo(THERMO_OUT)!;
    expect(t.electronicEh).toBeCloseTo(-76.326421, 6);
    expect(t.zpeEh).toBeCloseTo(0.021145, 6);
    expect(t.zpeKcal).toBeCloseTo(13.27, 2);
    expect(t.innerEh).toBeCloseTo(-76.302384, 6);
    expect(t.enthalpyEh).toBeCloseTo(-76.30144, 5);
    expect(t.entropyEh).toBeCloseTo(-0.021438, 6);
    expect(t.entropyKcal).toBeCloseTo(-13.45, 2);
    expect(t.gibbsEh).toBeCloseTo(-76.322878, 6);
    expect(t.gMinusEEh).toBeCloseTo(0.003543, 6);
    expect(t.gMinusEKcal).toBeCloseTo(2.22, 2);
    expect(t.totalCorrEh).toBeCloseTo(0.024037, 6);
  });

  test("extracts conditions, correction and entropy terms", () => {
    const t = parseThermo(THERMO_OUT.replace(
      "Electronic energy",
      `${THERMO_DETAIL}Electronic energy`,
    ))!;
    expect(t.temperatureK).toBeCloseTo(298.15, 2);
    expect(t.pressureAtm).toBeCloseTo(1.0, 2);
    expect(t.quasiRRHO).toBe(true);
    expect(t.thermalVibCorrEh).toBeCloseTo(0.01523103, 7);
    expect(t.thermalVibCorrKcal).toBeCloseTo(9.56, 2);
    expect(t.thermalRotCorrEh).toBeCloseTo(0.00141627, 7);
    expect(t.thermalTransCorrEh).toBeCloseTo(0.00141627, 7);
    expect(t.totalThermalCorrEh).toBeCloseTo(0.01806358, 7);
    expect(t.enthalpyCorrEh).toBeCloseTo(0.00094421, 7);
    expect(t.electronicEntropyEh).toBeCloseTo(0.00065446, 7);
    expect(t.vibEntropyEh).toBeCloseTo(0.02720226, 7);
    expect(t.rotEntropyEh).toBeCloseTo(0.01599066, 7);
    expect(t.transEntropyEh).toBeCloseTo(0.0204472, 7);
    expect(t.finalEntropyTermEh).toBeCloseTo(0.06429457, 7);
    expect(t.finalEntropyTermKcal).toBeCloseTo(40.35, 2);
  });

  test("returns null on text without a thermo block", () => {
    expect(parseThermo("FINAL SINGLE POINT ENERGY  -76.3\n")).toBeNull();
  });

  test("uses the LAST thermo section (calc_hess prints an earlier one)", () => {
    const initial = THERMO_OUT.replace("-76.32287800", "-76.10000000");
    const text = `${initial}\nGEOMETRY OPTIMIZATION CYCLE   1\nTHE OPTIMIZATION HAS CONVERGED\n${THERMO_OUT}`;
    const t = parseThermo(text)!;
    expect(t.gibbsEh).toBeCloseTo(-76.322878, 6);
  });

  test("returns null when an opt run only has a pre-convergence section", () => {
    // calc_hess prints freq + thermo for the STARTING geometry; without a
    // final Freq there is no section that describes the optimized one.
    const text = `${THERMO_OUT}\nGEOMETRY OPTIMIZATION CYCLE   1\nTHE OPTIMIZATION HAS CONVERGED\n`;
    expect(parseThermo(text)).toBeNull();
  });
});

describe("mergeRunThermo", () => {
  const run = {
    id: "r",
    experimentId: "e",
    status: "finished",
    startedAt: 0,
    zpeEh: 0.02,
    gibbsEh: -76.5,
  } as Run;

  test("uses the run record when nothing was parsed", () => {
    const t = mergeRunThermo(run, null)!;
    expect(t.gibbsEh).toBe(-76.5);
    expect(t.zpeEh).toBe(0.02);
    expect(t.zpeKcal).toBeCloseTo(0.02 * HARTREE_TO_KCAL, 6);
    expect(t.electronicEh).toBeNull();
  });

  test("parsed values win per-field over the record", () => {
    const parsed = { ...mergeRunThermo(run, null)!, gibbsEh: -76.6, electronicEh: -76.9 };
    const t = mergeRunThermo(run, parsed)!;
    expect(t.gibbsEh).toBe(-76.6);
    expect(t.electronicEh).toBe(-76.9);
    expect(t.zpeEh).toBe(0.02);
  });

  test("falls through to the parse when the record has no thermo", () => {
    const bare = { id: "r", experimentId: "e", status: "finished", startedAt: 0 } as Run;
    expect(mergeRunThermo(bare, null)).toBeNull();
  });
});

const PROPS_OUT = `
----------------
ORBITAL ENERGIES
----------------
  NO   OCC          E(Eh)            E(eV)
   0   2.0000     -18.123456      -493.164
   1   2.0000      -0.923456       -25.128
   2   2.0000      -0.472000       -12.844
   3   0.0000       0.061000         1.660
   4   0.0000       0.152000         4.136

MULLIKEN ATOMIC CHARGES
-----------------------
   0 O :   -0.612345
   1 H :    0.306173
   2 H :    0.306172
Sum of atomic charges:    0.0000000

Mayer bond orders larger than 0.100000
B(  0-O ,  1-H ) :   0.8842 B(  0-O ,  2-H ) :   0.8843

Total Dipole Moment    :      0.603846       0.000000       0.474748
Magnitude (a.u.)       :      0.768100
Magnitude (Debye)      :      1.952400
`;

describe("parseOutProperties", () => {
  test("extracts HOMO/LUMO, charges, bond orders and dipole", () => {
    const p = parseOutProperties(PROPS_OUT);
    expect(p.orbitals).toMatchObject({ homoMO: 2, lumoMO: 3 });
    expect(p.orbitals!.homo).toBeCloseTo(-0.472, 5);
    expect(p.orbitals!.lumo).toBeCloseTo(0.061, 5);
    expect(p.orbitals!.gapEh).toBeCloseTo(0.533, 5);
    expect(p.mulliken).toHaveLength(3);
    expect(p.mulliken![0]).toMatchObject({ idx: 0, element: "O" });
    expect(p.npa).toBeNull();
    expect(p.bondOrders).toHaveLength(2);
    expect(p.bondOrders![0]!.order).toBeCloseTo(0.8843, 4);
    expect(p.dipoleDebye).toBeCloseTo(1.9524, 4);
  });

  test("returns nulls on unrelated text", () => {
    const p = parseOutProperties("nothing to see here");
    expect(p.orbitals).toBeNull();
    expect(p.mulliken).toBeNull();
    expect(p.bondOrders).toBeNull();
    expect(p.dipoleDebye).toBeNull();
  });
});

describe("artifact-name extractors", () => {
  test("MO / cube-cycle / vib-mode / hessian indices", () => {
    expect(extractMOIndex("water.mo12a.cube")).toBe(12);
    expect(extractMOIndex("water.cube")).toBeNull();
    expect(extractCubeCycle("water.c7.mo12a.cube")).toBe(7);
    expect(extractCubeCycle("water.mo12a.cube")).toBeNull();
    expect(extractVibModeIndex("water.v6.xyz")).toBe(6);
    expect(extractVibModeIndex("water.xyz")).toBeNull();
    expect(extractHessianIndex("water.h2.v6.xyz")).toBe("2");
    expect(extractHessianIndex("water.v6.xyz")).toBeNull();
  });
});
