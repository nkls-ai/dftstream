import { expect, test } from "bun:test";
import {
  JOB_TYPES,
  METHOD_PRESETS,
  PRESET_ERRORS,
  SOLVENT_MODELS,
  jobTypeById,
  methodPresetsFor,
  solventModelsFor,
} from "./presets";
import { parseJobTypes, parseMethodPresets, parseSolventModels } from "./presetSchema";
import { JobTypeId, MethodFamily, SolventModelId } from "./types";

test("the shipped preset files load without errors", () => {
  expect(PRESET_ERRORS).toEqual([]);
  expect(JOB_TYPES.length).toBeGreaterThan(0);
  expect(METHOD_PRESETS.length).toBeGreaterThan(0);
  expect(SOLVENT_MODELS.length).toBe(3);
});

test("every job id in the YAML exists in JobTypeId", () => {
  // The Go renderer keys off the same ids; a job here with no
  // inputbuild.JobType would generate an input the CLI cannot reproduce.
  const known = new Set<string>(Object.values(JobTypeId));
  for (const job of JOB_TYPES) expect(known.has(job.id)).toBe(true);
});

test("job keywords match the run keywords ORCA expects", () => {
  expect(jobTypeById(JobTypeId.OptFreq)?.keywords).toEqual(["Opt", "Freq"]);
  expect(jobTypeById(JobTypeId.SP)?.keywords).toEqual([]);
  expect(jobTypeById(JobTypeId.NEBTSFreq)?.keywords).toEqual(["NEB-TS", "Freq"]);
  expect(jobTypeById(JobTypeId.NEBTSFreq)?.needsEndpoint).toBe(true);
  // A relaxed scan is driven by the %geom block; the run keyword is a
  // plain Opt, and TD-DFT contributes none at all.
  expect(jobTypeById(JobTypeId.Scan)?.keywords).toEqual(["Opt"]);
  expect(jobTypeById(JobTypeId.TDDFT)?.keywords).toEqual([]);
  expect(jobTypeById(JobTypeId.NMR)?.keywords).toEqual(["NMR"]);
  expect(jobTypeById(JobTypeId.MECP)?.keywords).toEqual(["MECP"]);
});

test("every job type has a preset that offers it", () => {
  // A job nothing can run is a dead entry in the select: the user picks
  // it and the method list empties under them.
  for (const job of JOB_TYPES) {
    expect(methodPresetsFor(job.id).length, `no preset offers ${job.id}`).toBeGreaterThan(0);
  }
});

test("each parameter group is claimed by exactly the jobs that need it", () => {
  const claiming = (flag: "needsScan" | "needsTddft" | "needsMecp" | "needsEndpoint") =>
    JOB_TYPES.filter((j) => j[flag]).map((j) => j.id);
  expect(claiming("needsScan")).toEqual([JobTypeId.Scan]);
  expect(claiming("needsTddft")).toEqual([JobTypeId.TDDFT]);
  expect(claiming("needsMecp")).toEqual([JobTypeId.MECP]);
  expect(claiming("needsEndpoint")).toEqual([JobTypeId.NEBTS, JobTypeId.NEBTSFreq]);
});

test("every JobTypeId is offered by the preset file", () => {
  // The Go table is pinned to the same YAML by
  // wrapper/internal/inputbuild/yamlparity_test.go, so this closes the
  // loop: enum ↔ YAML ↔ Go table.
  const offered = new Set(JOB_TYPES.map((j) => j.id));
  for (const id of Object.values(JobTypeId)) {
    expect(offered.has(id), `${id} is in JobTypeId but not in jobs.v1.yaml`).toBe(true);
  }
});

test("method presets carry no run keywords", () => {
  // Run keywords belong to the job type; a preset that smuggles one in
  // would emit it twice (or fight the job the user picked).
  const runKeywords = new Set(["opt", "freq", "optts", "neb-ts", "irc", "goat", "goat-entropy", "numfreq"]);
  for (const preset of METHOD_PRESETS) {
    for (const kw of preset.keywords) {
      expect(runKeywords.has(kw.toLowerCase())).toBe(false);
    }
  }
});

test("the lab's top three keyword lines are present, ranked by real usage", () => {
  const ranked = methodPresetsFor(JobTypeId.OptFreq);
  expect(ranked[0]?.id).toBe("r2scan-3c");
  expect(ranked[0]?.observed).toBe(241);
  expect(METHOD_PRESETS.find((p) => p.id === "wb97x-d4-tzvp")?.observed).toBe(224);
  expect(METHOD_PRESETS.find((p) => p.id === "wb97x-d3-tzvp-opt")?.observed).toBe(189);
});

test("ALPB is offered to xTB only", () => {
  expect(solventModelsFor(MethodFamily.Semiempirical).map((m) => m.id)).toEqual([SolventModelId.ALPB]);
  expect(solventModelsFor(MethodFamily.DFT).map((m) => m.id)).toEqual([
    SolventModelId.CPCM,
    SolventModelId.SMD,
  ]);
});

test("a wrong schema version is refused rather than half-read", () => {
  const load = parseJobTypes({ version: 99, jobs: [{ id: "opt", keywords: ["Opt"] }] });
  expect(load.items).toEqual([]);
  expect(load.errors[0]).toContain("not supported");
});

test("unknown ids and malformed entries are reported, never guessed", () => {
  const jobs = parseJobTypes({ version: 1, jobs: [{ id: "quantum-magic", keywords: [] }] });
  expect(jobs.items).toEqual([]);
  expect(jobs.errors[0]).toContain("unknown job id");

  const methods = parseMethodPresets(
    { version: 1, presets: [{ id: "x", family: "dft", keywords: ["B3LYP"], jobs: ["opt"], defaultJob: "sp" }] },
    new Set([JobTypeId.Opt]),
  );
  expect(methods.items).toEqual([]);
  expect(methods.errors[0]).toContain("not in its own jobs list");

  const solvents = parseSolventModels({ version: 1, models: [{ id: "cosmo", keyword: "COSMO", solvents: ["Water"] }] });
  expect(solvents.items).toEqual([]);
  expect(solvents.errors[0]).toContain("unknown model id");
});

test("a preset naming an unknown job is dropped whole", () => {
  const load = parseMethodPresets(
    { version: 1, presets: [{ id: "x", family: "dft", keywords: ["B3LYP"], jobs: ["opt", "teleport"], defaultJob: "opt" }] },
    new Set([JobTypeId.Opt]),
  );
  expect(load.items).toEqual([]);
  expect(load.errors.some((e) => e.includes("teleport"))).toBe(true);
});
