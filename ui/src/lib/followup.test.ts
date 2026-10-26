import { describe, expect, test } from "bun:test";
import { bangTokens, chargeMult, cliCommand, FollowupError, GENERATORS, type FollowupSource } from "./followup";

const HCN_XYZ = "3\nhcn\nC 0.000000 0.000000 0.000000\nN 0.000000 0.000000 1.160000\nH 0.000000 0.000000 -1.070000\n";
const HNC_XYZ = "3\nhnc\nC 0.000000 0.000000 0.000000\nN 0.000000 0.000000 1.160000\nH 0.000000 0.000000 2.160000\n";

function src(over: Partial<FollowupSource> = {}): FollowupSource {
  return {
    runName: "hcn",
    experimentName: "Sn2",
    inputText: "! XTB Opt Freq TightSCF\n%pal nprocs 4 end\n%maxcore 3000\n* xyz 0 1\nC 0 0 0\nN 0 0 1.16\nH 0 0 -1.07\n*\n",
    finalXyz: HCN_XYZ,
    converged: true,
    imaginaryModes: 0,
    ...over,
  };
}

describe("keyword surgery", () => {
  test("bangTokens reads all '!' lines and drops comments", () => {
    expect(bangTokens("! B3LYP def2-SVP # comment\n* xyz 0 1\n!  Opt  Freq\n")).toEqual([
      "B3LYP", "def2-SVP", "Opt", "Freq",
    ]);
  });

  test("chargeMult reads the coordinate header", () => {
    expect(chargeMult("* xyz -1 2\n")).toEqual({ charge: -1, mult: 2 });
    expect(chargeMult("no coords here")).toEqual({ charge: 0, mult: 1 });
  });
});

describe("neb-ts generator", () => {
  test("produces the input and the product endpoint file", () => {
    const res = GENERATORS["neb-ts"].generate([src(), src({ runName: "hnc", finalXyz: HNC_XYZ })], { nimages: 12 });
    expect(res.files.map((f) => f.name)).toEqual(["hcn_neb-ts.inp", "hcn_neb-ts_reactant.xyz", "hcn_neb-ts_product.xyz"]);
    const inp = res.files[0]!.content;
    expect(inp).toContain('# dftstream: edge=neb-ts parent="Sn2/hcn"');
    expect(inp).toContain("! XTB TightSCF NEB-TS Freq");
    expect(inp).toContain("%pal nprocs 4 end");
    expect(inp).toContain('NEB_End_XYZFile "hcn_neb-ts_product.xyz"');
    expect(inp).toContain("Nimages 12");
    // ORCA's NEB aborts on an inline starting structure.
    expect(inp).toContain("* xyzfile 0 1 hcn_neb-ts_reactant.xyz");
    expect(inp).not.toContain("* xyz 0 1");
  });

  test("refuses mismatched systems", () => {
    const twoAtoms = "2\nx\nH 0 0 0\nH 0 0 0.7\n";
    expect(() => GENERATORS["neb-ts"].generate([src(), src({ finalXyz: twoAtoms })])).toThrow(FollowupError);
    const swappedElements = "3\nx\nN 0 0 0\nC 0 0 1.16\nH 0 0 -1.07\n";
    expect(() => GENERATORS["neb-ts"].generate([src(), src({ finalXyz: swappedElements })])).toThrow(/element sequence/);
    expect(() =>
      GENERATORS["neb-ts"].generate([src(), src({ inputText: "! XTB Opt\n* xyz -1 2\nC 0 0 0\n*\n" })]),
    ).toThrow(/charge\/multiplicity/);
  });

  test("refuses an unconverged endpoint", () => {
    expect(() => GENERATORS["neb-ts"].generate([src({ converged: false }), src()])).toThrow(/never converged/);
  });
});

describe("irc generator", () => {
  test("strips job keywords and adds IRC", () => {
    const res = GENERATORS.irc.generate([src({ runName: "ts", inputText: "! XTB OptTS Freq\n* xyz 0 1\nC 0 0 0\n*\n", imaginaryModes: 1 })]);
    const inp = res.files[0]!.content;
    expect(res.files[0]!.name).toBe("ts_irc.inp");
    expect(inp).toContain("! XTB IRC\n");
    expect(inp).not.toContain("OptTS");
    expect(inp).toContain('edge=irc parent="Sn2/ts"');
  });

  test("refuses when the imaginary-mode count is wrong", () => {
    expect(() => GENERATORS.irc.generate([src({ imaginaryModes: 0 })])).toThrow(/exactly 1/);
    expect(() => GENERATORS.irc.generate([src({ imaginaryModes: 2 })])).toThrow(/exactly 1/);
  });

  test("warns when frequencies are unknown but still generates", () => {
    const res = GENERATORS.irc.generate([src({ imaginaryModes: undefined })]);
    expect(res.files).toHaveLength(1);
    expect(res.warnings.some((w) => w.includes("could not verify"))).toBe(true);
  });
});

describe("opt-endpoints generator", () => {
  const trj = `${HCN_XYZ}3\nmid\nC 0.0 0.0 0.1\nN 0.0 0.0 1.2\nH 0.0 0.0 -0.9\n${HNC_XYZ}`;

  test("takes the first and last frame of the full trajectory", () => {
    const res = GENERATORS["opt-endpoints"].generate([src({ runName: "irc", inputText: "! XTB IRC\n* xyz 0 1\nC 0 0 0\n*\n" })], { ircFullTrj: trj });
    expect(res.files.map((f) => f.name)).toEqual(["irc_irc_ep1_opt.inp", "irc_irc_ep2_opt.inp"]);
    expect(res.files[0]!.content).toContain("H       0.00000000     0.00000000    -1.07000000");
    expect(res.files[1]!.content).toContain("H       0.00000000     0.00000000     2.16000000");
    expect(res.files[0]!.content).toContain("! XTB Opt Freq");
  });

  test("errors without a trajectory", () => {
    expect(() => GENERATORS["opt-endpoints"].generate([src()], { ircFullTrj: "" })).toThrow(/trajectory/);
  });
});

describe("sp generator", () => {
  test("replaces the method and carries the solvent over", () => {
    const res = GENERATORS.sp.generate([src({ inputText: "! r2SCAN-3c Opt Freq CPCM(water)\n%maxcore 4000\n* xyz 0 1\nC 0 0 0\n*\n" })], {
      method: "! DLPNO-CCSD(T) cc-pVTZ cc-pVTZ/C TightSCF",
    });
    const inp = res.files[0]!.content;
    expect(inp).toContain("! DLPNO-CCSD(T) cc-pVTZ cc-pVTZ/C TightSCF CPCM(water)");
    expect(inp).not.toContain("r2SCAN-3c");
    expect(inp).toContain("%maxcore 4000");
    expect(res.warnings.some((w) => w.includes("solvent"))).toBe(true);
  });

  test("requires a method", () => {
    expect(() => GENERATORS.sp.generate([src()], { method: "  " })).toThrow(/choose a method/);
  });
});

describe("cliCommand", () => {
  test("mirrors the generated action", () => {
    expect(cliCommand("neb-ts", ["r", "p"], { nimages: 10 })).toBe("dftstream next neb-ts -nimages 10 r.out p.out");
    expect(cliCommand("irc", ["ts"])).toBe("dftstream next irc ts.out");
    expect(cliCommand("sp", ["min"], { method: "DLPNO-CCSD(T) cc-pVTZ" })).toBe(
      'dftstream next sp -method "DLPNO-CCSD(T) cc-pVTZ" min.out',
    );
  });
});
