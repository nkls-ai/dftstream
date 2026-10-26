/**
 * The builder's state and everything derived from it — pure, so the
 * whole "what will this produce?" question is testable without React.
 */
import { renderFreqBlock, renderGeomScanBlock, renderMecpBlock, renderTddftBlock, scanProblems } from "./blocks";
import { buildKeywordLine, parseKeywordLine } from "./keywords";
import { applyOverrides, defaultOverrides, type AdvancedOverrides } from "./overrides";
import { jobTypeById, methodPresetById, solventModelById } from "./presets";
import { renderInput, renderXYZFile } from "./render";
import {
  DEFAULT_ENVIRONMENT,
  JobTypeId,
  ScanCoordId,
  SolventModelId,
  type Environment,
  type InputSpec,
  type MECPSettings,
  type Resources,
  type ScanSettings,
  type Structure,
  type TDDFTSettings,
  type ThermoSettings,
} from "./types";

export interface BuilderState {
  /** Base name of the generated files, without extension. */
  baseName: string;
  job: JobTypeId;
  presetId: string;
  /** Typed overrides of the preset's method tokens (advanced panel). */
  overrides: AdvancedOverrides;
  /** Free-form extra '!' tokens from the advanced panel. */
  extraKeywords: string;
  /** Free-form extra `%…end` blocks, appended verbatim. */
  extraBlocks: string;
  env: Environment;
  /** Thermochemistry conditions (%freq), used when the job computes one. */
  thermo: ThermoSettings;
  res: Resources;
  /** Selected machine profile id; "" = no profile (checks off). */
  profileId: string;
  /** Requested walltime in hours; 0 = unset. Checked against the
   *  profile's cap — ORCA inputs carry no walltime themselves. */
  walltimeHours: number;
  /** Physical RAM of the target machine (MB); 0 = unknown. Derived from
   *  the profile when one is selected. */
  totalRAMMB: number;
  structure: Structure | null;
  /** Product endpoint, for the NEB jobs that need one. */
  endpoint: Structure | null;
  /** Number of NEB images; 0 uses ORCA's band default. */
  nebImages: number;
  /** Driven coordinate, for the scan job. */
  scan: ScanSettings;
  /** %tddft request, for the TD-DFT job. */
  tddft: TDDFTSettings;
  /** Second-surface multiplicity, for the MECP job. */
  mecp: MECPSettings;
}

/** ORCA's practical default band size for a first NEB-TS attempt. */
export const DEFAULT_NEB_IMAGES = 8;

export function defaultBuilderState(): BuilderState {
  return {
    baseName: "job",
    job: JobTypeId.OptFreq,
    presetId: "r2scan-3c",
    overrides: defaultOverrides(),
    extraKeywords: "",
    extraBlocks: "",
    env: { ...DEFAULT_ENVIRONMENT },
    thermo: { temperatureK: 0, pressureAtm: 0 },
    res: { nprocs: 8, maxCoreMB: 3000 },
    profileId: "",
    walltimeHours: 0,
    totalRAMMB: 0,
    structure: null,
    endpoint: null,
    nebImages: DEFAULT_NEB_IMAGES,
    scan: { coord: ScanCoordId.Bond, atoms: [0, 1], from: 1.0, to: 2.0, steps: 11 },
    tddft: { nroots: 8, triplets: false },
    mecp: { mult2: 3 },
  };
}

export interface GeneratedFile {
  name: string;
  content: string;
}

/** Sanitizes a user-typed base name into something safe on a cluster. */
export function safeBaseName(name: string): string {
  const cleaned = name.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "job";
}

export function needsEndpoint(job: JobTypeId): boolean {
  return jobTypeById(job)?.needsEndpoint ?? false;
}

export function needsScan(job: JobTypeId): boolean {
  return jobTypeById(job)?.needsScan ?? false;
}

export function needsTddft(job: JobTypeId): boolean {
  return jobTypeById(job)?.needsTddft ?? false;
}

export function needsMecp(job: JobTypeId): boolean {
  return jobTypeById(job)?.needsMecp ?? false;
}

export function needsFrequencies(job: JobTypeId): boolean {
  return jobTypeById(job)?.needsFrequencies ?? false;
}

/** The `%…end` blocks for the job — typed ones first, then anything typed
 *  by hand. Order matches the Go generators. */
export function blocksFor(state: BuilderState): string[] {
  const blocks: string[] = [];
  if (needsEndpoint(state.job)) {
    const images = state.nebImages > 0 ? state.nebImages : DEFAULT_NEB_IMAGES;
    blocks.push(`%neb\n  NEB_End_XYZFile "${safeBaseName(state.baseName)}_product.xyz"\n  Nimages ${images}\nend`);
  }
  if (needsScan(state.job)) blocks.push(renderGeomScanBlock(state.scan));
  if (needsTddft(state.job)) blocks.push(renderTddftBlock(state.tddft));
  if (needsMecp(state.job)) blocks.push(renderMecpBlock(state.mecp));
  if (needsFrequencies(state.job)) {
    const freq = renderFreqBlock(state.thermo);
    if (freq) blocks.push(freq);
  }
  const extra = state.extraBlocks.trim();
  if (extra) blocks.push(extra);
  return blocks.filter((b) => b !== "");
}

/** The preset's method tokens with the typed overrides applied. */
export function methodKeywords(state: BuilderState): string[] {
  const preset = methodPresetById(state.presetId);
  return applyOverrides(preset?.keywords ?? [], state.overrides);
}

export function buildSpec(state: BuilderState): InputSpec {
  const preset = methodPresetById(state.presetId);
  const base = safeBaseName(state.baseName);
  return {
    keywords: buildKeywordLine(
      preset,
      state.job,
      state.env,
      parseKeywordLine(state.extraKeywords),
      methodKeywords(state),
    ),
    env: state.env,
    res: state.res,
    blocks: blocksFor(state),
    structure: state.structure,
    // A NEB band cannot start from an inline structure: ORCA's band code
    // goes looking for per-image GBW files and aborts.
    xyzFileName: needsEndpoint(state.job) ? `${base}_reactant.xyz` : null,
  };
}

export function buildInputText(state: BuilderState): string {
  return renderInput(buildSpec(state));
}

/**
 * Every file the builder would write: the input, plus the endpoint .xyz
 * files a NEB job references.
 */
export function buildFiles(state: BuilderState, inputText: string): GeneratedFile[] {
  const base = safeBaseName(state.baseName);
  const files: GeneratedFile[] = [{ name: `${base}.inp`, content: inputText }];
  if (needsEndpoint(state.job) && state.structure) {
    files.push({
      name: `${base}_reactant.xyz`,
      content: renderXYZFile(state.structure.label || "reactant endpoint", state.structure.atoms),
    });
    if (state.endpoint) {
      files.push({
        name: `${base}_product.xyz`,
        content: renderXYZFile(state.endpoint.label || "product endpoint", state.endpoint.atoms),
      });
    }
  }
  return files;
}

/** Blocking problems the builder itself knows about, before linting. */
export function structureProblems(state: BuilderState): string[] {
  const out: string[] = [];
  if (!state.structure) out.push("no structure yet — paste coordinates, upload a structure file, or enter a SMILES");
  if (needsEndpoint(state.job) && !state.endpoint) {
    out.push("this job interpolates between two structures — a product endpoint is required");
  }
  if (state.structure && state.endpoint) {
    const a = state.structure.atoms;
    const b = state.endpoint.atoms;
    if (a.length !== b.length) {
      out.push(`endpoints have different atom counts (${a.length} vs ${b.length})`);
    } else {
      const mismatch = a.findIndex((atom, i) => atom.el !== b[i]!.el);
      if (mismatch >= 0) {
        out.push(
          `endpoint atom ${mismatch + 1} is ${b[mismatch]!.el}, not ${a[mismatch]!.el} — NEB endpoints must share identical atom ordering`,
        );
      }
    }
  }
  if (needsScan(state.job)) {
    out.push(...scanProblems(state.scan, state.structure?.atoms.length ?? 0));
  }
  if (needsTddft(state.job) && state.tddft.nroots < 1) {
    out.push("TD-DFT needs at least one root — set how many excited states to solve for");
  }
  if (needsMecp(state.job)) {
    if (state.mecp.mult2 < 1) {
      out.push("the second surface needs a multiplicity ≥ 1 (2S+1)");
    } else if (state.mecp.mult2 === state.env.multiplicity) {
      out.push(
        `both surfaces have multiplicity ${state.env.multiplicity} — an MECP search needs two different spin states`,
      );
    }
  }
  return out;
}

/** Solvent choices valid for the selected method, "" when none apply. */
export function solventChoices(state: BuilderState): string[] {
  const model = solventModelById(state.env.model);
  return model ? model.solvents : [];
}

/** Applies a preset switch: its default job stays valid and its
 *  preferred solvent model is offered instead of an impossible one. */
export function applyPreset(state: BuilderState, presetId: string): BuilderState {
  const preset = methodPresetById(presetId);
  if (!preset) return state;
  const job = preset.jobs.includes(state.job) ? state.job : preset.defaultJob;
  const model = solventModelById(state.env.model);
  const modelStillValid = model !== null && model.methodFamilies.includes(preset.family);
  const env: Environment =
    state.env.model === SolventModelId.None || modelStillValid
      ? state.env
      : { ...state.env, model: SolventModelId.None, solvent: "" };
  return { ...state, presetId, job, env };
}
