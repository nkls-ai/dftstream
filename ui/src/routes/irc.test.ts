import { test, expect, describe } from "bun:test";
import { parseIRCOutput, buildIRCPath, mergeIRCXYZ } from "./irc";

const IRC_OUTPUT = `
                       ****************************
                       * INTRINSIC REACTION COORD.*
                       ****************************

STARTING DIRECTION : FORWARD

IRC STEP   0
-----------
E           ...   -16.98466120 Eh
dE          ...     0.00000000
RMS(F)      ...     0.00421000

CARTESIAN COORDINATES (ANGSTROEM)
C     0.000000    0.000000    0.000000
O    -0.600000    1.100000    0.000000

IRC STEP   1
-----------
E           ...   -16.98521340 Eh
dE          ...    -0.00055220
RMS(F)      ...     0.00389000

IRC STEP   2
-----------
E           ...   -16.98612450 Eh
dE          ...    -0.00091110
RMS(F)      ...     0.00312000

         ****  THE IRC IN FORWARD DIRECTION HAS CONVERGED  ****

Now changing to BACKWARD direction

IRC STEP   0
-----------
E           ...   -16.98466120 Eh
dE          ...     0.00000000
RMS(F)      ...     0.00421000

IRC STEP   1
-----------
E           ...   -16.98518900 Eh
dE          ...    -0.00052780
RMS(F)      ...     0.00401000

IRC STEP   2
-----------
E           ...   -16.98607300 Eh
dE          ...    -0.00088400

         ****  IRC CONVERGED  ****
`;

describe("parseIRCOutput", () => {
  test("parses forward + backward steps", () => {
    const result = parseIRCOutput(IRC_OUTPUT);
    expect(result).not.toBeNull();
    expect(result!.forward).toHaveLength(3);
    expect(result!.backward).toHaveLength(3);
  });

  test("extracts energies correctly", () => {
    const r = parseIRCOutput(IRC_OUTPUT)!;
    expect(r.forward[0]!.energy).toBeCloseTo(-16.9846612, 6);
    expect(r.forward[1]!.energy).toBeCloseTo(-16.9852134, 6);
    expect(r.forward[2]!.energy).toBeCloseTo(-16.9861245, 6);
    expect(r.backward[1]!.energy).toBeCloseTo(-16.9851890, 6);
  });

  test("extracts dE correctly", () => {
    const r = parseIRCOutput(IRC_OUTPUT)!;
    expect(r.forward[0]!.dE).toBe(0);
    expect(r.forward[1]!.dE).toBeCloseTo(-0.0005522, 7);
  });

  test("extracts RMS force", () => {
    const r = parseIRCOutput(IRC_OUTPUT)!;
    expect(r.forward[0]!.rmsForce).toBeCloseTo(0.00421, 5);
  });

  test("sets tsEnergy from step 0", () => {
    const r = parseIRCOutput(IRC_OUTPUT)!;
    expect(r.tsEnergy).toBeCloseTo(-16.9846612, 6);
  });

  test("detects convergence", () => {
    expect(parseIRCOutput(IRC_OUTPUT)!.converged).toBe(true);
  });

  test("returns null for non-IRC output", () => {
    expect(parseIRCOutput("GEOMETRY OPTIMIZATION CYCLE 1\nFINAL SINGLE POINT ENERGY -75.0")).toBeNull();
  });

  test("parses inline geometry", () => {
    const r = parseIRCOutput(IRC_OUTPUT)!;
    expect(r.forward[0]!.xyz).toBeDefined();
    expect(r.forward[0]!.xyz).toContain("C     0.000000");
    expect(r.forward[0]!.xyz).toContain("O    -0.600000");
  });

  test("handles partial output (forward only)", () => {
    const partial = `
                       * INTRINSIC REACTION COORD.*

STARTING DIRECTION : FORWARD

IRC STEP   0
-----------
E           ...   -10.50000000 Eh
dE          ...     0.00000000

IRC STEP   1
-----------
E           ...   -10.50120000 Eh
dE          ...    -0.00120000
`;
    const r = parseIRCOutput(partial);
    expect(r).not.toBeNull();
    expect(r!.forward).toHaveLength(2);
    expect(r!.backward).toHaveLength(0);
    expect(r!.converged).toBe(false);
  });
});

describe("buildIRCPath", () => {
  test("combines backward reversed + forward, TS once", () => {
    const summary = parseIRCOutput(IRC_OUTPUT)!;
    const path = buildIRCPath(summary);
    expect(path).toHaveLength(5);
    expect(path[0]!.pathIndex).toBe(-2);
    expect(path[0]!.direction).toBe("backward");
    expect(path[2]!.pathIndex).toBe(0);
    expect(path[4]!.pathIndex).toBe(2);
    expect(path[4]!.direction).toBe("forward");
  });

  test("TS at relative energy 0", () => {
    const summary = parseIRCOutput(IRC_OUTPUT)!;
    const path = buildIRCPath(summary);
    const tsPoint = path.find((p) => p.pathIndex === 0);
    expect(tsPoint!.relativeKcal).toBeCloseTo(0, 3);
  });

  test("endpoints are lower energy than TS", () => {
    const summary = parseIRCOutput(IRC_OUTPUT)!;
    const path = buildIRCPath(summary);
    expect(path[0]!.relativeKcal).toBeLessThan(0);
    expect(path[path.length - 1]!.relativeKcal).toBeLessThan(0);
  });
});

// ORCA 6 compact format — iteration tables + PATH SUMMARY with "<= TS" marker
const ORCA6_IRC_OUTPUT = `
--------------------------------------------------------------------------------
                   Intrinsic Reaction Coordinate Calculation
--------------------------------------------------------------------------------

         *************************************************************
         *                          FORWARD IRC                      *
         *************************************************************

Iteration    E(Eh)      dE(kcal/mol)  max(|G|)   RMS(G)
Convergence thresholds                0.002000  0.000500
    0      -974.762897    1.487744    0.016349  0.005552
    1      -974.766073   -0.504639    0.006961  0.001858
    2      -974.766886   -1.015279    0.003926  0.001026
    3      -974.766976   -1.071711    0.002583  0.000686
    4      -974.767036   -1.109206    0.001680  0.000536
    5      -974.767072   -1.131741    0.001381  0.000430

                      ***********************HURRAY********************
                      ***            THE IRC HAS CONVERGED          ***
                      *************************************************


         *************************************************************
         *                          BACKWARD IRC                     *
         *************************************************************

Iteration    E(Eh)      dE(kcal/mol)  max(|G|)   RMS(G)
Convergence thresholds                0.002000  0.000500
    0      -974.763079    1.373764    0.019563  0.005545
    1      -974.766275   -0.631630    0.006215  0.001823
    2      -974.766844   -0.988571    0.004600  0.001138
    3      -974.766974   -1.070552    0.002881  0.000756
    4      -974.767123   -1.163528    0.001928  0.000443

                      ***********************HURRAY********************
                      ***            THE IRC HAS CONVERGED          ***
                      *************************************************


---------------------------------------------------------------
                       IRC PATH SUMMARY
---------------------------------------------------------------
All gradients are in Eh/Bohr.

Step        E(Eh)      dE(kcal/mol)  max(|G|)   RMS(G)
   1      -974.767123   -1.163528    0.001928  0.000443
   2      -974.766974   -1.070552    0.002881  0.000756
   3      -974.766844   -0.988571    0.004600  0.001138
   4      -974.766275   -0.631630    0.006215  0.001823
   5      -974.763079    1.373764    0.019563  0.005545
   6      -974.765268    0.000000    0.000009  0.000003 <= TS
   7      -974.762897    1.487744    0.016349  0.005552
   8      -974.766073   -0.504639    0.006961  0.001858
   9      -974.766886   -1.015279    0.003926  0.001026
  10      -974.766976   -1.071711    0.002583  0.000686
  11      -974.767036   -1.109206    0.001680  0.000536
  12      -974.767072   -1.131741    0.001381  0.000430

ORCA TERMINATED NORMALLY
`;

describe("parseIRCOutput (ORCA 6 compact format)", () => {
  test("parses forward + backward from iteration tables", () => {
    const r = parseIRCOutput(ORCA6_IRC_OUTPUT);
    expect(r).not.toBeNull();
    expect(r!.forward).toHaveLength(6);
    expect(r!.backward).toHaveLength(5);
  });

  test("extracts energies from compact table", () => {
    const r = parseIRCOutput(ORCA6_IRC_OUTPUT)!;
    expect(r.forward[0]!.energy).toBeCloseTo(-974.762897, 5);
    expect(r.forward[5]!.energy).toBeCloseTo(-974.767072, 5);
    expect(r.backward[0]!.energy).toBeCloseTo(-974.763079, 5);
    expect(r.backward[4]!.energy).toBeCloseTo(-974.767123, 5);
  });

  test("detects convergence", () => {
    expect(parseIRCOutput(ORCA6_IRC_OUTPUT)!.converged).toBe(true);
  });

  test("tsEnergy from PATH SUMMARY TS row", () => {
    const r = parseIRCOutput(ORCA6_IRC_OUTPUT)!;
    expect(r.tsEnergy).toBeCloseTo(-974.765268, 5);
  });

  test("buildIRCPath produces correct path", () => {
    const summary = parseIRCOutput(ORCA6_IRC_OUTPUT)!;
    const path = buildIRCPath(summary);
    expect(path.length).toBeGreaterThan(0);
    const tsPoint = path.find((p) => p.pathIndex === 0);
    expect(tsPoint).toBeDefined();
    expect(tsPoint!.relativeKcal).toBeCloseTo(0, 2);
  });

  test("endpoints lower energy than TS", () => {
    const summary = parseIRCOutput(ORCA6_IRC_OUTPUT)!;
    const path = buildIRCPath(summary);
    expect(path[0]!.relativeKcal).toBeLessThan(0);
    expect(path[path.length - 1]!.relativeKcal).toBeLessThan(0);
  });
});

describe("mergeIRCXYZ", () => {
  test("attaches frames from full trajectory", () => {
    const summary = parseIRCOutput(IRC_OUTPUT)!;
    const path = buildIRCPath(summary);
    const frames = path.map(
      (_, i) => `2\nframe ${i}\nC  0.0 0.0 ${i}.0\nO  1.0 0.0 ${i}.0`,
    );
    const trjText = frames.join("\n");
    const merged = mergeIRCXYZ(path, trjText);
    expect(merged[0]!.xyz).toContain("frame 0");
    expect(merged[4]!.xyz).toContain("frame 4");
  });

  test("falls back to inline xyz when no trajectory", () => {
    const summary = parseIRCOutput(IRC_OUTPUT)!;
    const path = buildIRCPath(summary);
    const merged = mergeIRCXYZ(path);
    const tsPoint = merged.find((p) => p.pathIndex === 0);
    expect(tsPoint!.xyz).toContain("C     0.000000");
  });
});
