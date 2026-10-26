import { describe, expect, test } from "bun:test";
import { highlightOrcaLine, type OrcaSyntaxMode } from "./highlight";

function classes(line: string, mode: OrcaSyntaxMode): string[] {
  return highlightOrcaLine(line, mode)
    .tokens.map((token) => token.className)
    .filter((className): className is string => !!className);
}

describe("ORCA syntax highlighter", () => {
  test("highlights simple input method, basis, run type, and solvent syntax", () => {
    const highlighted = highlightOrcaLine("! B3LYP def2-SVP Opt Freq TightSCF CPCM(water)", "input");

    expect(highlighted.className).toBe("orca-line-input-simple");
    expect(classes("! B3LYP def2-SVP Opt Freq TightSCF CPCM(water)", "input")).toContain("orca-method");
    expect(classes("! B3LYP def2-SVP Opt Freq TightSCF CPCM(water)", "input")).toContain("orca-basis");
    expect(classes("! B3LYP def2-SVP Opt Freq TightSCF CPCM(water)", "input")).toContain("orca-keyword");
  });

  test("highlights block input controls and block terminators", () => {
    expect(highlightOrcaLine("%pal nprocs 16 end", "input").className).toBe(
      "orca-line-input-block",
    );
    expect(classes("%pal nprocs 16 end", "input")).toEqual(
      expect.arrayContaining(["orca-block", "orca-property", "orca-number", "orca-end"]),
    );
  });

  test("highlights coordinates, element symbols, and numeric fields", () => {
    expect(highlightOrcaLine("* xyz 0 1", "input").className).toBe(
      "orca-line-input-coords",
    );
    expect(highlightOrcaLine("C 0.000 1.250 -0.130", "input").className).toBe(
      "orca-line-input-atom",
    );
    expect(classes("C 0.000 1.250 -0.130", "input")).toEqual(
      expect.arrayContaining(["orca-element", "orca-number"]),
    );
  });

  test("highlights output energies, convergence, warnings, and normal termination", () => {
    expect(highlightOrcaLine("FINAL SINGLE POINT ENERGY     -75.123456789", "output").className).toBe(
      "orca-line-output-energy",
    );
    expect(highlightOrcaLine("SCF CONVERGED AFTER 9 CYCLES", "output").className).toBe(
      "orca-line-output-scf",
    );
    expect(highlightOrcaLine("WARNING: Small HOMO/LUMO gap", "output").className).toBe(
      "orca-line-output-warning",
    );
    expect(highlightOrcaLine("****ORCA TERMINATED NORMALLY****", "output").className).toBe(
      "orca-line-output-success",
    );
  });

  test("keeps ordinary output log lines visually quiet", () => {
    const highlighted = highlightOrcaLine("Program Version 6.0.1 - running on node42", "output");

    expect(highlighted.className).toBeUndefined();
    expect(highlighted.tokens).toEqual([
      { text: "Program Version 6.0.1 - running on node42" },
    ]);
  });

  test("does not treat arbitrary all-caps output as a section", () => {
    const highlighted = highlightOrcaLine("THIS IS JUST A NOISY MESSAGE WITH 123 VALUES", "output");

    expect(highlighted.className).toBeUndefined();
    expect(classes("THIS IS JUST A NOISY MESSAGE WITH 123 VALUES", "output")).toEqual([]);
  });

  test("still highlights known output sections without coloring every coordinate row", () => {
    expect(highlightOrcaLine("CARTESIAN COORDINATES (ANGSTROEM)", "output").className).toBe(
      "orca-line-output-section",
    );
    expect(highlightOrcaLine("  0 C    0.000000   1.250000  -0.130000", "output").className).toBeUndefined();
    expect(classes("  0 C    0.000000   1.250000  -0.130000", "output")).toEqual([]);
  });

  test("highlights GOAT setup, iterations, convergence rows, and final ensemble results", () => {
    expect(highlightOrcaLine("                       *              GOAT             *", "output").className).toBe(
      "orca-line-output-goat",
    );
    expect(highlightOrcaLine("  GOAT version                               ... entropy", "output").className).toBe(
      "orca-line-output-goat",
    );
    expect(highlightOrcaLine("\t\t\t     GOAT Global Iter 3", "output").className).toBe(
      "orca-line-output-goat",
    );
    expect(highlightOrcaLine("          Energy change      -0.0000016404            0.0000050000      YES", "output").className).toBe(
      "orca-line-output-convergence",
    );
    expect(classes("          Energy change      -0.0000016404            0.0000050000      YES", "output")).toEqual(
      expect.arrayContaining(["orca-number", "orca-status-good"]),
    );
    expect(highlightOrcaLine("\t\tGlobal minimum found!", "output").className).toBe(
      "orca-line-output-success",
    );
    expect(highlightOrcaLine("\t\t        0     0.000\t     4      53.87      53.87", "output").className).toBe(
      "orca-line-output-goat-result",
    );
    expect(highlightOrcaLine("\t\t   3    -27.366325   1.543       -0.366", "output").className).toBe(
      "orca-line-output-goat-result",
    );
  });

  test("keeps repeated xTB orbital table rows plain in GOAT outputs", () => {
    expect(highlightOrcaLine("         25        2.0000           -0.3927785             -10.6880 (HOMO)", "output").className).toBeUndefined();
    expect(classes("         25        2.0000           -0.3927785             -10.6880 (HOMO)", "output")).toEqual([]);
  });

  test("highlights XYZ atom counts, comments, elements, and coordinates", () => {
    expect(highlightOrcaLine("18", "xyz").className).toBe("orca-line-xyz-count");
    expect(highlightOrcaLine("Energy=-27.366325 frame 3", "xyz").className).toBe(
      "orca-line-xyz-comment",
    );
    expect(classes("Energy=-27.366325 frame 3", "xyz")).toEqual(
      expect.arrayContaining(["orca-output-keyword", "orca-number"]),
    );

    const atom = highlightOrcaLine("C     -1.023400    0.204500    1.220000", "xyz");
    expect(atom.className).toBe("orca-line-xyz-atom");
    expect(classes("C     -1.023400    0.204500    1.220000", "xyz")).toEqual(
      expect.arrayContaining(["orca-element", "orca-number"]),
    );
  });

  test("supports extended XYZ atom rows with extra columns", () => {
    const atom = highlightOrcaLine("Fe 0.0 1.2 -3.4 0.125 1 2", "xyz");

    expect(atom.className).toBe("orca-line-xyz-atom");
    expect(classes("Fe 0.0 1.2 -3.4 0.125 1 2", "xyz")).toEqual(
      expect.arrayContaining(["orca-element", "orca-number"]),
    );
  });
});
