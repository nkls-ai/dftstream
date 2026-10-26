// In-UI generation of the TS workflow's follow-up inputs — the browser
// mirror of the wrapper's `dftstream next`. Same keyword surgery, same
// validations, same provenance comment, so a downloaded input behaves
// exactly like a CLI-generated one (including the parent-run link when it
// is submitted). Pure and React-free.

import { parseMultiXYZ } from "../components/xyz";

export type FollowupKind = "neb-ts" | "irc" | "opt-endpoints" | "sp";

/** One parent run's inputs to a generator. */
export interface FollowupSource {
  /** Run name — used for the provenance comment and generated filenames. */
  runName: string;
  /** Experiment name — the other half of the provenance parent reference. */
  experimentName: string;
  /** The run's original ORCA input text. */
  inputText: string;
  /** Final geometry as a single-frame XYZ string. */
  finalXyz: string;
  /** Imaginary-mode count, when known (IRC gate). */
  imaginaryModes?: number;
  converged?: boolean;
}

export interface GeneratedFile {
  name: string;
  content: string;
}

export interface GenerateResult {
  files: GeneratedFile[];
  warnings: string[];
}

export class FollowupError extends Error {}

// --- keyword surgery (mirrors wrapper/internal/inputparse predicates) ---

const OPT_TOKENS = new Set(["OPT", "OPTTS", "COPT", "TIGHTOPT", "VERYTIGHTOPT", "LOOSEOPT", "NORMALOPT"]);
const FREQ_TOKENS = new Set(["FREQ", "NUMFREQ", "ANFREQ"]);
const NEB_TOKENS = new Set([
  "NEB", "NEB-CI", "NEB-TS", "ZOOM-NEB", "ZOOM-NEB-CI", "ZOOM-NEB-TS", "NEB-IDPP",
  "FAST-NEB-TS", "LOOSE-NEB-TS", "TIGHT-NEB-TS",
]);

function isJobToken(tok: string): boolean {
  const up = tok.toUpperCase();
  return OPT_TOKENS.has(up) || FREQ_TOKENS.has(up) || NEB_TOKENS.has(up) || up === "IRC" || up === "SCANTS";
}

/** The '!' tokens of an input, in order, comments stripped. */
export function bangTokens(inputText: string): string[] {
  const out: string[] = [];
  for (const raw of inputText.split("\n")) {
    const line = raw.split("#")[0]!.trim();
    if (!line.startsWith("!")) continue;
    out.push(...line.slice(1).trim().split(/\s+/).filter(Boolean));
  }
  return out;
}

/** Strips every job keyword and appends the follow-up's own. */
function jobKeywords(inputText: string, ...add: string[]): string[] {
  return [...bangTokens(inputText).filter((t) => !isJobToken(t)), ...add];
}

// --- input pieces ---

const RE_CHARGE_MULT = /^\s*\*\s*(?:xyz|xyzfile|gzmt|int)\s+(-?\d+)\s+(\d+)/im;
const RE_PAL = /^\s*%\s*pal\b[\s\S]*?\bend\b/im;
const RE_MAXCORE = /^\s*%\s*maxcore\s+\d+/im;

export function chargeMult(inputText: string): { charge: number; mult: number } {
  const m = RE_CHARGE_MULT.exec(inputText);
  return { charge: m ? Number(m[1]) : 0, mult: m ? Number(m[2]) : 1 };
}

function resourceBlocks(inputText: string): string {
  const pal = RE_PAL.exec(inputText)?.[0]?.trim();
  const maxcore = RE_MAXCORE.exec(inputText)?.[0]?.trim();
  return [pal, maxcore].filter(Boolean).join("\n");
}

function provenance(kind: FollowupKind | "restart", src: FollowupSource): string {
  return `# dftstream: edge=${kind} parent="${src.experimentName}/${src.runName}"\n`;
}

/** Atom lines (element + coordinates) of a single-frame XYZ. */
function atomLines(xyz: string): string[] {
  const lines = xyz.split("\n");
  const n = Number(lines[0]?.trim());
  if (!Number.isFinite(n) || n <= 0) throw new FollowupError("could not read the geometry (malformed XYZ)");
  const rows: string[] = [];
  for (let i = 0; i < n; i++) {
    const parts = (lines[i + 2] ?? "").trim().split(/\s+/);
    if (parts.length < 4) throw new FollowupError("geometry is truncated");
    const [el, x, y, z] = parts;
    rows.push(`${el!.padEnd(3)} ${(+x!).toFixed(8).padStart(14)} ${(+y!).toFixed(8).padStart(14)} ${(+z!).toFixed(8).padStart(14)}`);
  }
  return rows;
}

function elements(xyz: string): string[] {
  const lines = xyz.split("\n");
  const n = Number(lines[0]?.trim());
  if (!Number.isFinite(n) || n <= 0) return [];
  return Array.from({ length: n }, (_, i) => (lines[i + 2] ?? "").trim().split(/\s+/)[0] ?? "");
}

function buildInput(
  kind: FollowupKind,
  src: FollowupSource,
  keywords: string[],
  xyz: string,
  extraBlocks: string[] = [],
): string {
  const { charge, mult } = chargeMult(src.inputText);
  const parts = [
    provenance(kind, src) + `! ${keywords.join(" ")}`,
    resourceBlocks(src.inputText),
    ...extraBlocks,
    `* xyz ${charge} ${mult}`,
    ...atomLines(xyz),
    "*",
  ];
  return parts.filter((p) => p !== "").join("\n") + "\n";
}

/** buildInput with the structure referenced from an external .xyz. ORCA's
 *  NEB aborts ("GBW-File <base>_im<N>.gbw not found") on an inline
 *  starting structure, so band inputs must use this form. */
function buildInputXYZFile(
  kind: FollowupKind,
  src: FollowupSource,
  keywords: string[],
  xyzName: string,
  extraBlocks: string[] = [],
): string {
  const { charge, mult } = chargeMult(src.inputText);
  const parts = [
    provenance(kind, src) + `! ${keywords.join(" ")}`,
    resourceBlocks(src.inputText),
    ...extraBlocks,
    `* xyzfile ${charge} ${mult} ${xyzName}`,
  ];
  return parts.filter((p) => p !== "").join("\n") + "\n";
}

function requireConverged(src: FollowupSource, what: string): void {
  if (src.converged === false) {
    throw new FollowupError(`${src.runName}: the optimization never converged — restart it before using its geometry for ${what}`);
  }
  if (!src.finalXyz.trim()) {
    throw new FollowupError(`${src.runName}: no final geometry available`);
  }
}

// --- generators ---

export interface GeneratorSpec {
  kind: FollowupKind;
  label: string;
  /** How many parent runs it consumes. */
  sources: number;
  generate(sources: FollowupSource[], opts?: { nimages?: number; method?: string; ircFullTrj?: string }): GenerateResult;
}

const nebTS: GeneratorSpec = {
  kind: "neb-ts",
  label: "NEB-TS search",
  sources: 2,
  generate([reactant, product], opts) {
    if (!reactant || !product) throw new FollowupError("need a reactant and a product run");
    requireConverged(reactant, "a NEB");
    requireConverged(product, "a NEB");
    const er = elements(reactant.finalXyz);
    const ep = elements(product.finalXyz);
    if (er.length !== ep.length) {
      throw new FollowupError(`atom count differs: ${er.length} vs ${ep.length} — NEB endpoints must be the same system`);
    }
    const mismatch = er.findIndex((e, i) => e.toUpperCase() !== ep[i]!.toUpperCase());
    if (mismatch >= 0) {
      throw new FollowupError(`element sequence differs at atom ${mismatch + 1} (${er[mismatch]} vs ${ep[mismatch]}) — NEB endpoints must share identical atom ordering`);
    }
    const cmR = chargeMult(reactant.inputText);
    const cmP = chargeMult(product.inputText);
    if (cmR.charge !== cmP.charge || cmR.mult !== cmP.mult) {
      throw new FollowupError(`charge/multiplicity differ: ${cmR.charge} ${cmR.mult} vs ${cmP.charge} ${cmP.mult}`);
    }
    const nimages = opts?.nimages && opts.nimages > 0 ? opts.nimages : 8;
    const reactantFile = `${reactant.runName}_neb-ts_reactant.xyz`;
    const productFile = `${reactant.runName}_neb-ts_product.xyz`;
    const nebBlock = `%neb\n  NEB_End_XYZFile "${productFile}"\n  Nimages ${nimages}\nend`;
    return {
      files: [
        {
          name: `${reactant.runName}_neb-ts.inp`,
          content: buildInputXYZFile("neb-ts", reactant, jobKeywords(reactant.inputText, "NEB-TS", "Freq"), reactantFile, [nebBlock]),
        },
        { name: reactantFile, content: reactant.finalXyz.trim() + "\n" },
        { name: productFile, content: product.finalXyz.trim() + "\n" },
      ],
      warnings: [],
    };
  },
};

const irc: GeneratorSpec = {
  kind: "irc",
  label: "IRC (both directions)",
  sources: 1,
  generate([ts]) {
    if (!ts) throw new FollowupError("need a TS run");
    requireConverged(ts, "an IRC");
    if (ts.imaginaryModes != null && ts.imaginaryModes !== 1) {
      throw new FollowupError(`${ts.runName}: ${ts.imaginaryModes} imaginary modes — a validated TS needs exactly 1, so an IRC from this geometry is meaningless`);
    }
    const warnings = ts.imaginaryModes == null
      ? ["no frequency data on this run — could not verify it is a first-order saddle point"]
      : [];
    warnings.push(`the CLI (\`dftstream next irc\`) also reuses the run's .hess via %irc InitHess Read — add that by hand to skip recomputing the Hessian`);
    return {
      files: [{ name: `${ts.runName}_irc.inp`, content: buildInput("irc", ts, jobKeywords(ts.inputText, "IRC"), ts.finalXyz) }],
      warnings,
    };
  },
};

const optEndpoints: GeneratorSpec = {
  kind: "opt-endpoints",
  label: "Opt Freq for both IRC endpoints",
  sources: 1,
  generate([ircRun], opts) {
    if (!ircRun) throw new FollowupError("need an IRC run");
    const frames = parseMultiXYZ(opts?.ircFullTrj ?? "");
    if (frames.length < 2) {
      throw new FollowupError("could not read the IRC trajectory — the run's *_IRC_Full_trj.xyz artifact is required");
    }
    const kws = jobKeywords(ircRun.inputText, "Opt", "Freq");
    return {
      files: [
        { name: `${ircRun.runName}_irc_ep1_opt.inp`, content: buildInput("opt-endpoints", ircRun, kws, frames[0]!) },
        { name: `${ircRun.runName}_irc_ep2_opt.inp`, content: buildInput("opt-endpoints", ircRun, kws, frames[frames.length - 1]!) },
      ],
      warnings: ["endpoints taken from the first and last frame of the full IRC trajectory"],
    };
  },
};

const singlePoint: GeneratorSpec = {
  kind: "sp",
  label: "High-level single point",
  sources: 1,
  generate([src], opts) {
    if (!src) throw new FollowupError("need a source run");
    requireConverged(src, "a single point");
    const method = (opts?.method ?? "").trim().replace(/^!/, "").trim();
    if (!method) throw new FollowupError("choose a method for the single point");
    const kws = method.split(/\s+/);
    const warnings: string[] = [];
    const solvent = /\b((?:CPCM|SMD|ALPB|C-PCM)\([^)]+\))/i.exec(src.inputText)?.[1];
    if (solvent && !kws.some((k) => /^(CPCM|SMD|ALPB|C-PCM)\(/i.test(k))) {
      kws.push(solvent);
      warnings.push(`carried the parent's solvent model over: ${solvent}`);
    }
    return {
      files: [{ name: `${src.runName}_sp.inp`, content: buildInput("sp", src, kws, src.finalXyz) }],
      warnings,
    };
  },
};

export const GENERATORS: Record<FollowupKind, GeneratorSpec> = {
  "neb-ts": nebTS,
  irc,
  "opt-endpoints": optEndpoints,
  sp: singlePoint,
};

/** The equivalent CLI command, shown next to every in-UI generation. */
export function cliCommand(kind: FollowupKind, sourceNames: string[], opts?: { method?: string; nimages?: number }): string {
  const files = sourceNames.map((n) => `${n}.out`).join(" ");
  switch (kind) {
    case "neb-ts":
      return `dftstream next neb-ts${opts?.nimages ? ` -nimages ${opts.nimages}` : ""} ${files}`;
    case "sp":
      return `dftstream next sp${opts?.method ? ` -method "${opts.method}"` : ""} ${files}`;
    default:
      return `dftstream next ${kind} ${files}`;
  }
}
