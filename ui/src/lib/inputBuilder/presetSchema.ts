/**
 * Validation of the YAML preset files into the typed model.
 *
 * The presets are data files a chemist can edit, so nothing here trusts
 * them: every entry that does not validate is reported as an error and
 * dropped. A bad preset must never reach a generated input — a silently
 * mistyped keyword costs a queue slot and a day.
 */
import {
  JobTypeId,
  MethodFamily,
  SolventModelId,
  type JobTypeDef,
  type MethodPreset,
  type SolventModelDef,
} from "./types";

export interface PresetLoad<T> {
  items: T[];
  errors: string[];
}

/** Schema version these parsers understand (the `version:` field). */
export const SUPPORTED_PRESET_VERSION = 1;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  return typeof v === "string" ? v.trim() : "";
}

function strArray(rec: Record<string, unknown>, key: string): string[] | null {
  const v = rec[key];
  if (v === undefined) return [];
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") return null;
    out.push(item.trim());
  }
  return out;
}

function bool(rec: Record<string, unknown>, key: string): boolean {
  return rec[key] === true;
}

function num(rec: Record<string, unknown>, key: string): number | null {
  const v = rec[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function enumValue<T extends string>(all: readonly T[], raw: string): T | null {
  return (all as readonly string[]).includes(raw) ? (raw as T) : null;
}

const JOB_IDS = Object.values(JobTypeId);
const FAMILIES = Object.values(MethodFamily);
const SOLVENT_IDS = Object.values(SolventModelId);

/** Unwraps `{version, <listKey>: [...]}`, checking the schema version. */
function entries(
  raw: unknown,
  listKey: string,
  file: string,
): { list: Record<string, unknown>[]; errors: string[] } {
  if (!isRecord(raw)) return { list: [], errors: [`${file}: not a YAML mapping`] };
  const version = num(raw, "version");
  if (version !== SUPPORTED_PRESET_VERSION) {
    return {
      list: [],
      errors: [
        `${file}: schema version ${version ?? "missing"} is not supported (this build reads v${SUPPORTED_PRESET_VERSION})`,
      ],
    };
  }
  const list = raw[listKey];
  if (!Array.isArray(list)) return { list: [], errors: [`${file}: missing "${listKey}" list`] };
  const errors: string[] = [];
  const out: Record<string, unknown>[] = [];
  list.forEach((item, i) => {
    if (!isRecord(item)) {
      errors.push(`${file}: ${listKey}[${i}] is not a mapping`);
      return;
    }
    out.push(item);
  });
  return { list: out, errors };
}

export function parseJobTypes(raw: unknown): PresetLoad<JobTypeDef> {
  const { list, errors } = entries(raw, "jobs", "jobs.yaml");
  const items: JobTypeDef[] = [];
  for (const rec of list) {
    const id = enumValue(JOB_IDS, str(rec, "id"));
    if (!id) {
      errors.push(`jobs.yaml: unknown job id "${str(rec, "id")}" — add it to JobTypeId (and inputbuild.JobType) first`);
      continue;
    }
    const keywords = strArray(rec, "keywords");
    if (keywords === null) {
      errors.push(`jobs.yaml: ${id}: "keywords" must be a list of strings`);
      continue;
    }
    items.push({
      id,
      label: str(rec, "label") || id,
      keywords,
      description: str(rec, "description"),
      needsFrequencies: bool(rec, "needsFrequencies"),
      needsEndpoint: bool(rec, "needsEndpoint"),
      needsScan: bool(rec, "needsScan"),
      needsTddft: bool(rec, "needsTddft"),
      needsMecp: bool(rec, "needsMecp"),
    });
  }
  return { items, errors };
}

export function parseMethodPresets(raw: unknown, knownJobs: ReadonlySet<JobTypeId>): PresetLoad<MethodPreset> {
  const { list, errors } = entries(raw, "presets", "methods.yaml");
  const items: MethodPreset[] = [];
  for (const rec of list) {
    const id = str(rec, "id");
    if (!id) {
      errors.push("methods.yaml: a preset has no id");
      continue;
    }
    const family = enumValue(FAMILIES, str(rec, "family"));
    if (!family) {
      errors.push(`methods.yaml: ${id}: unknown family "${str(rec, "family")}"`);
      continue;
    }
    const keywords = strArray(rec, "keywords");
    if (keywords === null || keywords.length === 0) {
      errors.push(`methods.yaml: ${id}: "keywords" must be a non-empty list of strings`);
      continue;
    }
    const jobsRaw = strArray(rec, "jobs");
    if (jobsRaw === null) {
      errors.push(`methods.yaml: ${id}: "jobs" must be a list of strings`);
      continue;
    }
    const jobs: JobTypeId[] = [];
    let jobError = false;
    for (const j of jobsRaw) {
      const jobId = enumValue(JOB_IDS, j);
      if (!jobId || !knownJobs.has(jobId)) {
        errors.push(`methods.yaml: ${id}: unknown job "${j}"`);
        jobError = true;
        continue;
      }
      jobs.push(jobId);
    }
    if (jobError) continue;
    const defaultJob = enumValue(JOB_IDS, str(rec, "defaultJob"));
    if (!defaultJob || !jobs.includes(defaultJob)) {
      errors.push(`methods.yaml: ${id}: defaultJob "${str(rec, "defaultJob")}" is not in its own jobs list`);
      continue;
    }
    const solventRaw = str(rec, "defaultSolventModel");
    const defaultSolventModel = solventRaw ? enumValue(SOLVENT_IDS, solventRaw) : SolventModelId.None;
    if (!defaultSolventModel) {
      errors.push(`methods.yaml: ${id}: unknown defaultSolventModel "${solventRaw}"`);
      continue;
    }
    items.push({
      id,
      label: str(rec, "label") || id,
      family,
      keywords,
      optTier: str(rec, "optTier") || null,
      defaultJob,
      jobs,
      defaultSolventModel,
      description: str(rec, "description"),
      observed: num(rec, "observed"),
    });
  }
  return { items, errors };
}

export function parseSolventModels(raw: unknown): PresetLoad<SolventModelDef> {
  const { list, errors } = entries(raw, "models", "solvents.yaml");
  const items: SolventModelDef[] = [];
  for (const rec of list) {
    const id = enumValue(SOLVENT_IDS, str(rec, "id"));
    if (!id || id === SolventModelId.None) {
      errors.push(`solvents.yaml: unknown model id "${str(rec, "id")}"`);
      continue;
    }
    const keyword = str(rec, "keyword");
    if (!keyword) {
      errors.push(`solvents.yaml: ${id}: missing "keyword" (the '!' line spelling)`);
      continue;
    }
    const familiesRaw = strArray(rec, "methodFamilies");
    const solvents = strArray(rec, "solvents");
    if (familiesRaw === null || solvents === null || solvents.length === 0) {
      errors.push(`solvents.yaml: ${id}: "methodFamilies" and a non-empty "solvents" list are required`);
      continue;
    }
    const methodFamilies: MethodFamily[] = [];
    let familyError = false;
    for (const f of familiesRaw) {
      const fam = enumValue(FAMILIES, f);
      if (!fam) {
        errors.push(`solvents.yaml: ${id}: unknown method family "${f}"`);
        familyError = true;
        continue;
      }
      methodFamilies.push(fam);
    }
    if (familyError) continue;
    items.push({
      id,
      keyword,
      label: str(rec, "label") || keyword,
      description: str(rec, "description"),
      methodFamilies,
      solvents,
    });
  }
  return { items, errors };
}
