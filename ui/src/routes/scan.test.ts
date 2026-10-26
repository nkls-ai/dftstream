import { describe, expect, test } from "bun:test";
import { parseScanDat, parseScanOutput } from "./scan";

const scanOutput = `
                       *    Relaxed Surface Scan    *
                      Bond (  1,   0):   range=   0.90000000 ..   1.10000000  steps =   3
                     Angle (  1,   0,   2):   range= 100.00000000 .. 110.00000000  steps =   2

         *               RELAXED SURFACE SCAN STEP   1               *
         *                 Bond (  1,   0)  :   0.90000000           *
         *                 Angle (  1,   0,   2)  : 100.00000000     *
FINAL SINGLE POINT ENERGY      -75.00000000
OPTIMIZATION RUN DONE

         *               RELAXED SURFACE SCAN STEP   2               *
         *                 Bond (  1,   0)  :   0.90000000           *
         *                 Angle (  1,   0,   2)  : 110.00000000     *
FINAL SINGLE POINT ENERGY      -74.99000000
OPTIMIZATION RUN DONE
`;

describe("scan parsing", () => {
  test("extracts multiple constrained coordinates from relaxed scan output", () => {
    const summary = parseScanOutput(scanOutput);
    expect(summary?.dimensions).toBe(2);
    expect(summary?.coordinates.map((c) => c.label)).toEqual([
      "Bond (1-0)",
      "Angle (1-0-2)",
    ]);
    expect(summary?.points[0]?.coords).toEqual([0.9, 100]);
    expect(summary?.points[1]?.energy).toBe(-74.99);
  });

  test("parses relaxscanact.dat with coordinate labels from output", () => {
    const outputSummary = parseScanOutput(scanOutput);
    const summary = parseScanDat(
      `
        0.90000000 100.00000000 -75.00000000
        0.90000000 110.00000000 -74.99000000
        1.00000000 100.00000000 -75.01000000
      `,
      outputSummary?.coordinates ?? [],
    );
    expect(summary?.dimensions).toBe(2);
    expect(summary?.coordLabel).toBe("Bond (1-0) × Angle (1-0-2)");
    expect(summary?.points).toHaveLength(3);
    expect(summary?.points[2]?.coordValue).toBe(1);
  });
});
