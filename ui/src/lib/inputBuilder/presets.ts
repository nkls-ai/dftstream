/**
 * Loads `presets/*.yaml` — the versioned, human-editable defaults — into
 * the typed model. Bun's bundler inlines the YAML, so the repo files are
 * the single source of truth with no generated copy to drift.
 *
 * Load errors are collected, never thrown: a broken preset file must
 * degrade the builder's choices, not blank the page.
 */
import jobsRaw from "../../../../presets/jobs.v1.yaml";
import methodsRaw from "../../../../presets/methods.v1.yaml";
import solventsRaw from "../../../../presets/solvents.v1.yaml";
import { parseJobTypes, parseMethodPresets, parseSolventModels } from "./presetSchema";
import {
  JobTypeId,
  SolventModelId,
  type JobTypeDef,
  type MethodFamily,
  type MethodPreset,
  type SolventModelDef,
} from "./types";

const jobLoad = parseJobTypes(jobsRaw);
const solventLoad = parseSolventModels(solventsRaw);
const methodLoad = parseMethodPresets(methodsRaw, new Set(jobLoad.items.map((j) => j.id)));

export const JOB_TYPES: readonly JobTypeDef[] = jobLoad.items;
export const METHOD_PRESETS: readonly MethodPreset[] = methodLoad.items;
export const SOLVENT_MODELS: readonly SolventModelDef[] = solventLoad.items;

/** Every problem found while loading the preset files, for the UI to show. */
export const PRESET_ERRORS: readonly string[] = [
  ...jobLoad.errors,
  ...methodLoad.errors,
  ...solventLoad.errors,
];

export function jobTypeById(id: JobTypeId): JobTypeDef | null {
  return JOB_TYPES.find((j) => j.id === id) ?? null;
}

export function methodPresetById(id: string): MethodPreset | null {
  return METHOD_PRESETS.find((p) => p.id === id) ?? null;
}

export function solventModelById(id: SolventModelId): SolventModelDef | null {
  return SOLVENT_MODELS.find((m) => m.id === id) ?? null;
}

/** The solvent models valid for a method family — ALPB is xTB's own
 *  model and produces an input ORCA rejects on a DFT run. */
export function solventModelsFor(family: MethodFamily): SolventModelDef[] {
  return SOLVENT_MODELS.filter((m) => m.methodFamilies.includes(family));
}

/** Presets that support a job, most-used first (unmeasured last). */
export function methodPresetsFor(job: JobTypeId): MethodPreset[] {
  return METHOD_PRESETS.filter((p) => p.jobs.includes(job)).sort(
    (a, b) => (b.observed ?? -1) - (a.observed ?? -1),
  );
}
