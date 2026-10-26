import { expect, test } from "bun:test";
import { buildKeywordLine, jobKeywords, mergeKeyword, parseKeywordLine, solventKeyword } from "./keywords";
import { methodPresetById } from "./presets";
import { JobTypeId, SolventModelId, type Environment } from "./types";

const gasPhase: Environment = { charge: 0, multiplicity: 1, model: SolventModelId.None, solvent: "" };
const water: Environment = { charge: 0, multiplicity: 1, model: SolventModelId.CPCM, solvent: "Water" };

test("the house workhorse renders the lab's own line", () => {
  const kws = buildKeywordLine(methodPresetById("r2scan-3c"), JobTypeId.OptFreq, gasPhase);
  expect(kws.join(" ")).toBe("r2SCAN-3c Opt Freq");
});

test("an opt tier replaces the plain Opt instead of doubling it", () => {
  // "! wB97X-D3 def2-TZVP TightOpt Freq CPCM(Water)" — 189 runs in the corpus.
  const kws = buildKeywordLine(methodPresetById("wb97x-d3-tzvp-opt"), JobTypeId.OptFreq, water);
  expect(kws.join(" ")).toBe("wB97X-D3 def2-TZVP TightOpt Freq CPCM(Water)");
  expect(kws).not.toContain("Opt");
});

test("the tier still applies to a TS search, which has no plain Opt", () => {
  const kws = jobKeywords(JobTypeId.OptTSFreq, "TightOpt");
  expect(kws).toEqual(["OptTS", "Freq"]);
});

test("a single point contributes no run keyword", () => {
  const kws = buildKeywordLine(methodPresetById("wb97x-v-qzvpp"), JobTypeId.SP, gasPhase);
  expect(kws.join(" ")).toBe("wB97X-V def2-QZVPP TightSCF DEFGRID3");
});

test("GOAT-Entropy with ALPB is the conformer-search line", () => {
  const env: Environment = { charge: 0, multiplicity: 1, model: SolventModelId.ALPB, solvent: "water" };
  const kws = buildKeywordLine(methodPresetById("xtb2-goat"), JobTypeId.GoatEntropy, env);
  expect(kws.join(" ")).toBe("XTB2 GOAT-Entropy ALPB(water)");
});

test("solvation without a solvent name is gas phase, not a broken call", () => {
  expect(solventKeyword({ ...gasPhase, model: SolventModelId.CPCM })).toBe("");
  expect(solventKeyword(water)).toBe("CPCM(Water)");
});

test("extra tokens merge in without duplicating what is already there", () => {
  const kws = buildKeywordLine(methodPresetById("r2scan-3c"), JobTypeId.OptFreq, gasPhase, ["TightSCF", "freq"]);
  expect(kws.join(" ")).toBe("r2SCAN-3c Opt Freq TightSCF");
});

test("mergeKeyword is case-insensitive and ignores blanks", () => {
  expect(mergeKeyword(["B3LYP"], "b3lyp")).toEqual(["B3LYP"]);
  expect(mergeKeyword(["B3LYP"], "  ")).toEqual(["B3LYP"]);
  expect(mergeKeyword(["B3LYP"], " def2-SVP ")).toEqual(["B3LYP", "def2-SVP"]);
});

test("a hand-typed keyword line round-trips", () => {
  expect(parseKeywordLine("  ! r2SCAN-3c   Opt Freq ")).toEqual(["r2SCAN-3c", "Opt", "Freq"]);
  expect(parseKeywordLine("XTB Opt")).toEqual(["XTB", "Opt"]);
  expect(parseKeywordLine("   ")).toEqual([]);
});
