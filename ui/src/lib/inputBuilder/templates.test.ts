import { expect, test } from "bun:test";
import { defaultBuilderState, buildInputText, type BuilderState } from "./builderState";
import { GridOverride, ScfOverride } from "./overrides";
import {
  applyTemplate,
  deserializeTemplateState,
  serializeTemplateState,
  TEMPLATE_STATE_VERSION,
} from "./templates";
import { JobTypeId, ScanCoordId, SolventModelId, StructureSource, type Structure } from "./types";

function structure(label: string): Structure {
  return { atoms: [{ el: "C", x: 0, y: 0, z: 0 }], source: StructureSource.Pasted, label };
}

function configured(): BuilderState {
  return {
    ...defaultBuilderState(),
    baseName: "solvated_optfreq",
    job: JobTypeId.Scan,
    presetId: "wb97x-d3-tzvp-opt",
    overrides: { ...defaultBuilderState().overrides, grid: GridOverride.DefGrid3, scf: ScfOverride.Tight },
    extraKeywords: "NoAutoStart",
    extraBlocks: "%scf\n  MaxIter 300\nend",
    env: { charge: -1, multiplicity: 2, model: SolventModelId.CPCM, solvent: "Acetonitrile" },
    thermo: { temperatureK: 310.15, pressureAtm: 1.5 },
    res: { nprocs: 16, maxCoreMB: 4000 },
    profileId: "workstation",
    walltimeHours: 24,
    totalRAMMB: 64 * 1024,
    scan: { coord: ScanCoordId.Dihedral, atoms: [3, 2, 1, 0], from: -180, to: 180, steps: 37 },
    tddft: { nroots: 12, triplets: true },
    mecp: { mult2: 5 },
    structure: structure("the molecule on screen"),
  };
}

test("a template round-trips every setting, and produces the same input", () => {
  const before = configured();
  const loaded = deserializeTemplateState(serializeTemplateState(before), TEMPLATE_STATE_VERSION);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  const after = applyTemplate(before, loaded.state);
  expect(after).toEqual(before);
  expect(buildInputText(after)).toBe(buildInputText(before));
});

test("a template carries settings, never the molecule", () => {
  const json = serializeTemplateState(configured());
  expect(json).not.toContain("the molecule on screen");
  const loaded = deserializeTemplateState(json, TEMPLATE_STATE_VERSION);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  expect(loaded.state.structure).toBeNull();
  expect(loaded.state.endpoint).toBeNull();
});

test("loading keeps the structure that is already on screen", () => {
  const current = { ...defaultBuilderState(), structure: structure("mine"), job: JobTypeId.SP };
  const loaded = deserializeTemplateState(serializeTemplateState(configured()), TEMPLATE_STATE_VERSION);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  const next = applyTemplate(current, loaded.state);
  expect(next.structure?.label).toBe("mine");
  expect(next.job).toBe(JobTypeId.Scan);
});

test("a payload from a newer build is refused, not half-read", () => {
  const res = deserializeTemplateState(serializeTemplateState(configured()), TEMPLATE_STATE_VERSION + 1);
  expect(res.ok).toBe(false);
  if (res.ok) return;
  expect(res.error).toContain("not supported");
});

test("malformed JSON and the wrong shape are refused", () => {
  expect(deserializeTemplateState("{not json", TEMPLATE_STATE_VERSION).ok).toBe(false);
  expect(deserializeTemplateState(JSON.stringify({ version: 1 }), TEMPLATE_STATE_VERSION).ok).toBe(false);
});

test("hand-edited nonsense degrades to defaults with a note, never into the state", () => {
  const payload = JSON.stringify({
    version: TEMPLATE_STATE_VERSION,
    state: {
      job: "teleport",
      presetId: "does-not-exist",
      env: { charge: "lots", multiplicity: -3, model: "cosmo" },
      res: { nprocs: -4 },
      scan: { coord: "Q", atoms: ["x", 2], steps: "many" },
    },
  });
  const loaded = deserializeTemplateState(payload, TEMPLATE_STATE_VERSION);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  const d = defaultBuilderState();
  expect(loaded.state.job).toBe(d.job);
  expect(loaded.state.env.charge).toBe(d.env.charge);
  expect(loaded.state.env.multiplicity).toBeGreaterThanOrEqual(1);
  expect(loaded.state.env.model).toBe(SolventModelId.None);
  expect(loaded.state.res.nprocs).toBe(0);
  expect(loaded.state.scan.coord).toBe(d.scan.coord);
  expect(loaded.state.scan.atoms).toEqual([2]);
  expect(loaded.notes.some((n) => n.includes("teleport"))).toBe(true);
  expect(loaded.notes.some((n) => n.includes("does-not-exist"))).toBe(true);
  // And whatever came out still renders a file, rather than throwing.
  expect(buildInputText(loaded.state)).toContain("!");
});
