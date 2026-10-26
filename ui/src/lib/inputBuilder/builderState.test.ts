import { expect, test } from "bun:test";
import {
  applyPreset,
  buildFiles,
  buildInputText,
  buildSpec,
  defaultBuilderState,
  safeBaseName,
  structureProblems,
  type BuilderState,
} from "./builderState";
import { hasErrors, lintInput } from "./lint";
import { ScfOverride } from "./overrides";
import {
  DEFAULT_ENVIRONMENT,
  JobTypeId,
  ScanCoordId,
  SolventModelId,
  StructureSource,
  type Structure,
} from "./types";

function structure(els: string[], label = ""): Structure {
  return {
    atoms: els.map((el, i) => ({ el, x: i * 1.2, y: 0, z: 0 })),
    source: StructureSource.Pasted,
    label,
  };
}

function state(over: Partial<BuilderState> = {}): BuilderState {
  return { ...defaultBuilderState(), structure: structure(["C", "N", "H"]), ...over };
}

test("the default state produces the lab's most common input", () => {
  expect(buildInputText(state())).toBe(
    `! r2SCAN-3c Opt Freq
%pal nprocs 8 end
%maxcore 3000
* xyz 0 1
C       0.00000000     0.00000000     0.00000000
N       1.20000000     0.00000000     0.00000000
H       2.40000000     0.00000000     0.00000000
*
`,
  );
});

test("solvation and charge flow into the generated input", () => {
  const text = buildInputText(
    state({
      presetId: "wb97x-d3-tzvp-opt",
      env: { charge: -1, multiplicity: 2, model: SolventModelId.CPCM, solvent: "Acetonitrile" },
    }),
  );
  expect(text).toContain("! wB97X-D3 def2-TZVP TightOpt Freq CPCM(Acetonitrile)\n");
  expect(text).toContain("* xyz -1 2\n");
});

test("a NEB job references both endpoints as files, never inline", () => {
  const s = state({
    baseName: "ts search",
    job: JobTypeId.NEBTSFreq,
    presetId: "r2scan-3c",
    endpoint: structure(["C", "N", "H"], "product"),
    nebImages: 12,
  });
  const text = buildInputText(s);
  expect(text).toContain("! r2SCAN-3c NEB-TS Freq\n");
  expect(text).toContain('%neb\n  NEB_End_XYZFile "ts_search_product.xyz"\n  Nimages 12\nend\n');
  expect(text).toContain("* xyzfile 0 1 ts_search_reactant.xyz\n");
  expect(text).not.toContain("* xyz 0 1\n");

  const files = buildFiles(s, text);
  expect(files.map((f) => f.name)).toEqual([
    "ts_search.inp",
    "ts_search_reactant.xyz",
    "ts_search_product.xyz",
  ]);
  expect(files[1]?.content.startsWith("3\n")).toBe(true);
});

test("a NEB band with no images falls back to ORCA's default", () => {
  const text = buildInputText(state({ job: JobTypeId.NEBTS, endpoint: structure(["C"]), nebImages: 0 }));
  expect(text).toContain("Nimages 8");
});

test("extra keywords and blocks from the advanced panel are appended", () => {
  const text = buildInputText(state({ extraKeywords: "! TightSCF DEFGRID3", extraBlocks: "%scf\n  MaxIter 300\nend" }));
  expect(text).toContain("! r2SCAN-3c Opt Freq TightSCF DEFGRID3\n");
  expect(text).toContain("%scf\n  MaxIter 300\nend\n");
});

test("file names are sanitized for a cluster filesystem", () => {
  expect(safeBaseName("  my job (v2)/final  ")).toBe("my_job_v2_final");
  expect(safeBaseName("///")).toBe("job");
  expect(buildFiles(state({ baseName: "α run" }), "x")[0]?.name).toBe("run.inp");
});

test("missing structures are reported before anything is generated", () => {
  expect(structureProblems(state({ structure: null }))[0]).toContain("no structure yet");
  const neb = state({ job: JobTypeId.NEBTSFreq });
  expect(structureProblems(neb)[0]).toContain("product endpoint is required");
});

test("mismatched NEB endpoints are refused the way the CLI refuses them", () => {
  const differentCount = state({ job: JobTypeId.NEBTS, endpoint: structure(["C", "N"]) });
  expect(structureProblems(differentCount)[0]).toContain("different atom counts");

  const differentOrder = state({ job: JobTypeId.NEBTS, endpoint: structure(["C", "H", "N"]) });
  expect(structureProblems(differentOrder)[0]).toContain("identical atom ordering");
});

test("switching to an SP-only preset moves the job with it", () => {
  const next = applyPreset(state({ job: JobTypeId.OptFreq }), "dlpno-ccsdt-tz");
  expect(next.job).toBe(JobTypeId.SP);
});

test("switching to xTB drops a solvent model xTB cannot use", () => {
  const solvated = state({ env: { charge: 0, multiplicity: 1, model: SolventModelId.CPCM, solvent: "Water" } });
  const next = applyPreset(solvated, "xtb2-goat");
  expect(next.env.model).toBe(SolventModelId.None);
  expect(next.env.solvent).toBe("");
});

test("switching between DFT presets keeps a valid solvent", () => {
  const solvated = state({ env: { charge: 0, multiplicity: 1, model: SolventModelId.SMD, solvent: "Water" } });
  const next = applyPreset(solvated, "wb97x-d4-tzvp");
  expect(next.env.model).toBe(SolventModelId.SMD);
});

test("a relaxed scan renders the %geom Scan block the CLI renders", () => {
  const text = buildInputText(
    state({
      job: JobTypeId.Scan,
      presetId: "xtb2-goat",
      scan: { coord: ScanCoordId.Bond, atoms: [0, 1], from: 1.1, to: 1.8, steps: 15 },
    }),
  );
  expect(text).toContain("! XTB2 Opt\n");
  expect(text).toContain("%geom\n  Scan\n    B 0 1 = 1.10, 1.80, 15\n  end\nend\n");
});

test("TD-DFT asks through the block, not a run keyword", () => {
  const text = buildInputText(
    state({ job: JobTypeId.TDDFT, presetId: "wb97x-d4-tzvp", tddft: { nroots: 10, triplets: true } }),
  );
  // No run keyword: the ground state is a single point, and the excited
  // states come from %tddft.
  expect(text).toContain("! wB97X-D4 def2-TZVP TightSCF DEFGRID3\n");
  expect(text).toContain("%tddft\n  NRoots 10\n  Triplets true\nend\n");
});

test("NMR carries its keyword and warns about a small basis nowhere else", () => {
  const text = buildInputText(state({ job: JobTypeId.NMR, presetId: "wb97x-d4-tzvp" }));
  expect(text).toContain("! wB97X-D4 def2-TZVP TightSCF DEFGRID3 NMR\n");
});

test("MECP names the second surface, and refuses two identical states", () => {
  const s = state({ job: JobTypeId.MECP, presetId: "r2scan-3c", mecp: { mult2: 3 } });
  const text = buildInputText(s);
  expect(text).toContain("! r2SCAN-3c MECP\n");
  expect(text).toContain("%mecp\n  Mult 3\nend\n");
  // State 1 is the input's own multiplicity — the MECP tab reads them in
  // that order, so two equal states are not a crossing at all.
  expect(structureProblems({ ...s, mecp: { mult2: 1 } }).some((p) => p.includes("two different spin states"))).toBe(
    true,
  );
});

test("thermo conditions reach %freq only when the job computes one", () => {
  const thermo = { temperatureK: 310.15, pressureAtm: 1.5 };
  expect(buildInputText(state({ job: JobTypeId.OptFreq, thermo }))).toContain(
    "%freq\n  Temp 310.15\n  Pressure 1.50\nend\n",
  );
  // An optimization has no thermochemistry to condition.
  expect(buildInputText(state({ job: JobTypeId.Opt, thermo }))).not.toContain("%freq");
  // And ORCA's own defaults stay ORCA's when nothing was typed.
  expect(buildInputText(state({ job: JobTypeId.OptFreq }))).not.toContain("%freq");
});

test("typed overrides replace the preset's tokens on the '!' line", () => {
  const text = buildInputText(
    state({
      presetId: "wb97x-d3-tzvp-opt",
      overrides: { ...defaultBuilderState().overrides, basis: "def2-QZVPP", scf: ScfOverride.VeryTight },
    }),
  );
  expect(text).toContain("! wB97X-D3 def2-QZVPP VeryTightSCF TightOpt Freq\n");
  expect(text).not.toContain("def2-TZVP ");
});

test("§3 acceptance: a SMILES plus two clicks is a valid solvated Opt+Freq", async () => {
  // The whole flow a first-year PhD student does, with nothing else
  // touched: type a SMILES, pick a solvent. Every other setting has to
  // already be right by default, or the acceptance criterion is a lie.
  const { loadEmbedBackend } = await import("../smiles/backend");
  const { smilesTo3DWith } = await import("../smiles/smiles");
  const backend = await loadEmbedBackend();
  expect("kind" in backend).toBe(false);
  if ("kind" in backend) return;

  const mol = smilesTo3DWith(backend, "CC(=O)Oc1ccccc1C(=O)O"); // aspirin
  expect(mol.ok).toBe(true);
  if (!mol.ok) return;

  // Click 1: adopt the structure (charge/spin come from the SMILES).
  // Click 2: pick the solvent.
  const s: BuilderState = {
    ...defaultBuilderState(),
    structure: { atoms: mol.molecule.atoms, source: StructureSource.Smiles, label: mol.molecule.smiles },
    env: {
      ...DEFAULT_ENVIRONMENT,
      charge: mol.molecule.charge,
      multiplicity: mol.molecule.multiplicity,
      model: SolventModelId.CPCM,
      solvent: "Water",
    },
  };

  expect(structureProblems(s)).toEqual([]);
  const text = buildInputText(s);
  expect(text).toContain("! r2SCAN-3c Opt Freq CPCM(Water)\n");
  expect(text).toContain("* xyz 0 1\n");

  // And it lints clean — no errors, and none of the resource infos that
  // would mean a default was left unset.
  const findings = lintInput(text, { availableFiles: buildFiles(s, text).map((f) => f.name) });
  expect(hasErrors(findings)).toBe(false);
  expect(findings).toEqual([]);
}, 20_000);

test("the spec keeps the structure the linter needs to see", () => {
  const spec = buildSpec(state());
  expect(spec.structure?.atoms.length).toBe(3);
  expect(spec.xyzFileName).toBeNull();
});
