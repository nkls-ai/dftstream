/**
 * Assembles the '!' keyword line from the typed choices: method preset +
 * job type + solvation. Mirrors `inputbuild.KeywordsFor` on the Go side.
 */
import { jobTypeById, solventModelById } from "./presets";
import { JobTypeId, SolventModelId, type Environment, type MethodPreset } from "./types";

/** ORCA's plain optimization keyword, the one an opt tier replaces. */
const OPT_KEYWORD = "Opt";

/** Appends tok unless an equal-folding token is already present. */
export function mergeKeyword(keywords: string[], tok: string): string[] {
  const t = tok.trim();
  if (!t) return keywords;
  if (keywords.some((k) => k.toLowerCase() === t.toLowerCase())) return keywords;
  return [...keywords, t];
}

/** The solvation call for an environment ("CPCM(water)"), or "" for gas phase. */
export function solventKeyword(env: Environment): string {
  if (env.model === SolventModelId.None || !env.solvent) return "";
  const model = solventModelById(env.model);
  if (!model) return "";
  return `${model.keyword}(${env.solvent})`;
}

/**
 * The job's run keywords, with the preset's optimization tier
 * substituted for a plain `Opt`: TightOpt is itself an ORCA run keyword
 * (it implies Opt), so "TightOpt Opt Freq" would be a duplicated
 * request. This reproduces the lab's own line, `… TightOpt Freq`.
 */
export function jobKeywords(job: JobTypeId, optTier: string | null): string[] {
  const def = jobTypeById(job);
  if (!def) return [];
  if (!optTier) return [...def.keywords];
  return def.keywords.map((k) => (k === OPT_KEYWORD ? optTier : k));
}

/**
 * The complete '!' token list: method tokens, then the job's run
 * keywords, then the solvation call. Extra tokens (the free-text escape
 * hatch) are merged in last, duplicates dropped. `methodTokens`, when
 * given, replaces the preset's own keywords — the seam through which the
 * typed override panel swaps a basis or grid without touching the rest.
 */
export function buildKeywordLine(
  preset: MethodPreset | null,
  job: JobTypeId,
  env: Environment,
  extra: string[] = [],
  methodTokens?: string[],
): string[] {
  let out: string[] = [];
  for (const k of methodTokens ?? preset?.keywords ?? []) out = mergeKeyword(out, k);
  for (const k of jobKeywords(job, preset?.optTier ?? null)) out = mergeKeyword(out, k);
  const solvent = solventKeyword(env);
  if (solvent) out = mergeKeyword(out, solvent);
  for (const k of extra) out = mergeKeyword(out, k);
  return out;
}

/** Splits a hand-typed keyword line ("! B3LYP def2-SVP" or bare) into tokens. */
export function parseKeywordLine(line: string): string[] {
  return line.replace(/^\s*!/, "").trim().split(/\s+/).filter(Boolean);
}
