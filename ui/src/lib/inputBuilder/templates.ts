/**
 * Serialization of a BuilderState into the org template library and
 * back. A template is the RECIPE — job, preset, overrides, environment,
 * resources — never the molecule: structures are stripped on save, so a
 * template stays small and applies to whatever structure is loaded.
 *
 * The payload is version-stamped. Loading refuses a version this build
 * does not understand instead of guessing at fields, and every field it
 * does read is validated against the typed model — a colleague's
 * hand-edited template must degrade to defaults, not corrupt the state.
 */
import { defaultBuilderState, type BuilderState } from "./builderState";
import { defaultOverrides, DispersionOverride, GridOverride, RIOverride, ScfOverride } from "./overrides";
import { jobTypeById, methodPresetById, solventModelById } from "./presets";
import { JobTypeId, ScanCoordId, SolventModelId } from "./types";

/** Version of the template payload this build reads and writes. */
export const TEMPLATE_STATE_VERSION = 1;

/** What a saved template looks like on the wire. */
interface TemplatePayload {
  version: number;
  state: Omit<BuilderState, "structure" | "endpoint">;
}

export function serializeTemplateState(state: BuilderState): string {
  const { structure: _structure, endpoint: _endpoint, ...rest } = state;
  const payload: TemplatePayload = { version: TEMPLATE_STATE_VERSION, state: rest };
  return JSON.stringify(payload);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function enumValue<T extends string>(all: readonly T[], v: unknown, fallback: T): T {
  return typeof v === "string" && (all as readonly string[]).includes(v) ? (v as T) : fallback;
}

export type TemplateLoad =
  | { ok: true; state: BuilderState; notes: string[] }
  | { ok: false; error: string };

/**
 * Parses a stored template payload into a fresh BuilderState. The
 * current structure/endpoint are NOT part of a template; the caller
 * carries them over from the live state.
 */
export function deserializeTemplateState(json: string, storedVersion: number): TemplateLoad {
  if (storedVersion !== TEMPLATE_STATE_VERSION) {
    return {
      ok: false,
      error: `template version ${storedVersion} is not supported (this build reads v${TEMPLATE_STATE_VERSION})`,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    // Malformed JSON in the store — refuse rather than guess.
    return { ok: false, error: "template payload is not valid JSON" };
  }
  if (!isRecord(raw) || raw.version !== TEMPLATE_STATE_VERSION || !isRecord(raw.state)) {
    return { ok: false, error: "template payload has an unexpected shape" };
  }
  const s = raw.state;
  const notes: string[] = [];
  const d = defaultBuilderState();

  const job = enumValue(Object.values(JobTypeId), s.job, d.job);
  if (job !== s.job) notes.push(`unknown job "${String(s.job)}" — using ${job}`);
  if (typeof s.job === "string" && jobTypeById(job) === null) {
    notes.push(`job "${job}" is not offered by this build's presets`);
  }

  const presetId = str(s.presetId, d.presetId);
  if (methodPresetById(presetId) === null) {
    notes.push(`method preset "${presetId}" is not in this build's preset files — pick one by hand`);
  }

  const env = isRecord(s.env) ? s.env : {};
  const model = enumValue(Object.values(SolventModelId), env.model, SolventModelId.None);
  if (model !== SolventModelId.None && solventModelById(model) === null) {
    notes.push(`solvent model "${model}" is unavailable`);
  }
  const overrides = isRecord(s.overrides) ? s.overrides : {};
  const thermo = isRecord(s.thermo) ? s.thermo : {};
  const res = isRecord(s.res) ? s.res : {};
  const scan = isRecord(s.scan) ? s.scan : {};
  const tddft = isRecord(s.tddft) ? s.tddft : {};
  const mecp = isRecord(s.mecp) ? s.mecp : {};

  const scanAtoms = Array.isArray(scan.atoms)
    ? scan.atoms.filter((a): a is number => typeof a === "number" && Number.isInteger(a) && a >= 0)
    : d.scan.atoms;

  const state: BuilderState = {
    ...d,
    baseName: str(s.baseName, d.baseName),
    job,
    presetId,
    overrides: {
      ...defaultOverrides(),
      functional: str(overrides.functional, ""),
      basis: str(overrides.basis, ""),
      auxBasis: str(overrides.auxBasis, ""),
      grid: enumValue(Object.values(GridOverride), overrides.grid, GridOverride.Default),
      scf: enumValue(Object.values(ScfOverride), overrides.scf, ScfOverride.Default),
      dispersion: enumValue(Object.values(DispersionOverride), overrides.dispersion, DispersionOverride.Default),
      ri: enumValue(Object.values(RIOverride), overrides.ri, RIOverride.Default),
    },
    extraKeywords: str(s.extraKeywords, ""),
    extraBlocks: str(s.extraBlocks, ""),
    env: {
      charge: num(env.charge, d.env.charge),
      multiplicity: Math.max(1, num(env.multiplicity, d.env.multiplicity)),
      model,
      solvent: str(env.solvent, ""),
    },
    thermo: {
      temperatureK: num(thermo.temperatureK, 0),
      pressureAtm: num(thermo.pressureAtm, 0),
    },
    res: {
      nprocs: Math.max(0, num(res.nprocs, d.res.nprocs)),
      maxCoreMB: Math.max(0, num(res.maxCoreMB, d.res.maxCoreMB)),
    },
    profileId: str(s.profileId, ""),
    walltimeHours: Math.max(0, num(s.walltimeHours, 0)),
    totalRAMMB: Math.max(0, num(s.totalRAMMB, 0)),
    nebImages: Math.max(0, num(s.nebImages, d.nebImages)),
    scan: {
      coord: enumValue(Object.values(ScanCoordId), scan.coord, d.scan.coord),
      atoms: scanAtoms,
      from: num(scan.from, d.scan.from),
      to: num(scan.to, d.scan.to),
      steps: Math.max(0, num(scan.steps, d.scan.steps)),
    },
    tddft: {
      nroots: Math.max(0, num(tddft.nroots, d.tddft.nroots)),
      triplets: bool(tddft.triplets, d.tddft.triplets),
    },
    mecp: { mult2: Math.max(0, num(mecp.mult2, d.mecp.mult2)) },
    structure: null,
    endpoint: null,
  };
  return { ok: true, state, notes };
}

/**
 * Applies a loaded template over the live state: everything from the
 * template, with the molecule (structure/endpoint) carried over.
 */
export function applyTemplate(current: BuilderState, loaded: BuilderState): BuilderState {
  return { ...loaded, structure: current.structure, endpoint: current.endpoint };
}
