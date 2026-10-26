/**
 * Pre-flight checks on the input text, ported from
 * `wrapper/internal/inputlint`: the mistakes that waste queue time.
 *
 *  - a charge/multiplicity pair that cannot match the electron count
 *    (ORCA aborts immediately — often hours after the job left the queue)
 *  - %maxcore × nprocs past the machine's RAM
 *  - a `* xyzfile` reference with nothing to resolve it to
 *  - keyword typos
 *  - non-ASCII characters (ORCA exits 50 on them, and the usual culprits
 *    — zero-width spaces, curly quotes — are invisible in an editor)
 *
 * Running here as well as in the CLI is the point: the builder catches
 * them before the file is ever written.
 */
import { electronCount, normalizeElement } from "./elements";
import { isRecognizedToken, nearestKeyword } from "./keywordVocabulary";

export enum LintSeverity {
  Error = "error",
  Warn = "warn",
  Info = "info",
}

export interface LintFinding {
  severity: LintSeverity;
  /** Stable machine-readable code, matching inputlint's. */
  code: string;
  message: string;
}

export interface LintOptions {
  /** Enables the %maxcore × nprocs check; 0 disables it. */
  totalRAMMB?: number;
  /** Enables the nprocs-vs-cores check; 0 disables it. Comes from the
   *  selected machine profile. */
  totalCores?: number;
  /** Names the builder will write next to the input (its own .xyz). */
  availableFiles?: string[];
}

const COORD_HEADER = /^[ \t]*\*[ \t]*(xyz|xyzfile|gzmt|int)[ \t]+(-?\d+)[ \t]+(\d+)[ \t]*(\S*)/im;
const COORD_ATOM = /^\s*([A-Za-z]{1,2})(?:\s|\()/;
const NPROCS = /%\s*pal\b[\s\S]*?nprocs\s*=?\s*(\d+)[\s\S]*?\bend\b/i;
const PAL_SHORT = /(?:^|\s)!\s*[^\n]*\bPAL(\d+)\b/i;
const MAXCORE = /%\s*maxcore\s+(\d+)/i;

const NON_ASCII_NAMES: Readonly<Record<string, string>> = {
  " ": "no-break space (invisible)",
  "​": "zero-width space (invisible)",
  "‌": "zero-width non-joiner (invisible)",
  "‍": "zero-width joiner (invisible)",
  "﻿": "byte-order mark (invisible)",
  "‘": "curly quote",
  "’": "curly quote",
  "“": "curly double quote",
  "”": "curly double quote",
  "–": "en dash",
  "—": "em dash",
  "−": "unicode minus sign",
};

const MAX_NON_ASCII_LINES = 5;

/** Every '!' token of the input, comments stripped. */
export function keywordTokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    let line = raw.trim();
    const hash = line.indexOf("#");
    if (hash >= 0) line = line.slice(0, hash);
    if (!line.startsWith("!")) continue;
    for (const tok of line.slice(1).trim().split(/\s+/)) {
      if (tok) out.push(tok);
    }
  }
  return out;
}

/** Runs every check; errors first, then warnings, then info. */
export function lintInput(text: string, opts: LintOptions = {}): LintFinding[] {
  const findings = [
    ...checkChargeMult(text, opts),
    ...checkResources(text, opts),
    ...checkKeywords(text),
    ...checkNonASCII(text),
  ];
  const rank = { [LintSeverity.Error]: 0, [LintSeverity.Warn]: 1, [LintSeverity.Info]: 2 };
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

export function hasErrors(findings: LintFinding[]): boolean {
  return findings.some((f) => f.severity === LintSeverity.Error);
}

function parityWord(n: number): string {
  return n % 2 === 0 ? "even" : "odd";
}

function checkChargeMult(text: string, opts: LintOptions): LintFinding[] {
  const m = COORD_HEADER.exec(text);
  if (!m) {
    return [{
      severity: LintSeverity.Warn,
      code: "no-coords",
      message: "no coordinate block found (* xyz CHARGE MULT … or * xyzfile CHARGE MULT file)",
    }];
  }
  const kind = m[1]!.toLowerCase();
  const charge = Number(m[2]);
  const mult = Number(m[3]);
  const fileRef = m[4] ?? "";
  const findings: LintFinding[] = [];

  if (mult < 1) {
    return [{
      severity: LintSeverity.Error,
      code: "mult-invalid",
      message: `multiplicity ${mult} is invalid — must be ≥ 1 (2S+1)`,
    }];
  }

  if (kind === "xyzfile") {
    if (!fileRef) {
      findings.push({
        severity: LintSeverity.Error,
        code: "xyzfile-missing",
        message: "* xyzfile names no coordinates file",
      });
    } else if (opts.availableFiles && !opts.availableFiles.includes(fileRef)) {
      findings.push({
        severity: LintSeverity.Warn,
        code: "xyzfile-missing",
        message: `coordinates file "${fileRef}" is not one of the files this input ships with — it must exist next to the input when the job runs`,
      });
    }
    return findings; // the electron count lives in a file we cannot read
  }

  const elements = inlineElements(text);
  if (elements === null || elements.length === 0) return findings;
  const neutral = electronCount(elements);
  if (neutral === null) {
    findings.push({
      severity: LintSeverity.Warn,
      code: "unknown-element",
      message: `unknown element symbol in coordinates — electron-parity check skipped`,
    });
    return findings;
  }
  const electrons = neutral - charge;
  if ((electrons - (mult - 1)) % 2 !== 0) {
    findings.push({
      severity: LintSeverity.Error,
      code: "charge-mult-parity",
      message:
        `charge ${charge} / multiplicity ${mult} is impossible: ${electrons} electrons ` +
        `(Σ Z − charge, ${elements.length} atoms) — an ${parityWord(electrons)} electron count ` +
        `needs an ${parityWord(electrons + 1)} multiplicity. ORCA will abort immediately.`,
    });
  }
  return findings;
}

/** Element symbols of an inline coordinate block, null when there is none. */
function inlineElements(text: string): string[] | null {
  const lines = text.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (COORD_HEADER.test(lines[i] ?? "")) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return null;
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed.startsWith("*")) break;
    if (!trimmed) continue;
    const m = COORD_ATOM.exec(line);
    if (!m) break;
    out.push(normalizeElement(m[1]!));
  }
  return out;
}

function checkResources(text: string, opts: LintOptions): LintFinding[] {
  const out: LintFinding[] = [];
  const palBlock = NPROCS.exec(text);
  const palShort = PAL_SHORT.exec(text);
  const nprocs = palBlock ? Number(palBlock[1]) : palShort ? Number(palShort[1]) : 0;
  const maxcoreMatch = MAXCORE.exec(text);
  const maxcore = maxcoreMatch ? Number(maxcoreMatch[1]) : 0;

  if (!nprocs) {
    out.push({
      severity: LintSeverity.Info,
      code: "no-pal",
      message: "no %pal / PALn — ORCA will run on a single core",
    });
  }
  if (!maxcore) {
    out.push({
      severity: LintSeverity.Info,
      code: "no-maxcore",
      message: "no %maxcore — ORCA's per-core default is conservative; large jobs may swap to disk integrals",
    });
  }
  const cores = opts.totalCores ?? 0;
  if (cores > 0 && nprocs > cores) {
    out.push({
      severity: LintSeverity.Warn,
      code: "nprocs-exceeds-cores",
      message:
        `%pal nprocs ${nprocs} on a machine with ${cores} cores — ` +
        `oversubscribed MPI ranks run slower than fewer ranks`,
    });
  }
  const ram = opts.totalRAMMB ?? 0;
  if (ram > 0 && maxcore > 0) {
    const procs = nprocs || 1;
    const total = maxcore * procs;
    // ORCA treats %maxcore as a soft target and overshoots; past ~75% of
    // physical RAM the OOM killer becomes a real risk.
    if (total > (ram * 3) / 4) {
      out.push({
        severity: LintSeverity.Warn,
        code: "maxcore-exceeds-ram",
        message:
          `%maxcore ${maxcore} MB × ${procs} procs = ${(total / 1024).toFixed(1)} GB requested, ` +
          `machine has ${(ram / 1024).toFixed(1)} GB — ORCA overshoots %maxcore, risk of OOM kill`,
      });
    }
  }
  return out;
}

function checkKeywords(text: string): LintFinding[] {
  const out: LintFinding[] = [];
  for (const tok of keywordTokens(text)) {
    if (isRecognizedToken(tok)) continue;
    const suggestion = nearestKeyword(tok);
    if (suggestion) {
      out.push({
        severity: LintSeverity.Warn,
        code: "keyword-typo",
        message: `keyword "${tok}" looks like a typo — did you mean "${suggestion}"? (ORCA aborts on unknown keywords)`,
      });
    }
  }
  return out;
}

function checkNonASCII(text: string): LintFinding[] {
  const out: LintFinding[] = [];
  let extra = 0;
  text.split("\n").forEach((line, i) => {
    let first = "";
    let count = 0;
    for (const ch of line) {
      if (ch.codePointAt(0)! > 0x7f) {
        if (!first) first = ch;
        count++;
      }
    }
    if (!first) return;
    if (out.length >= MAX_NON_ASCII_LINES) {
      extra++;
      return;
    }
    const name = NON_ASCII_NAMES[first] ?? "non-ASCII";
    const code = first.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
    out.push({
      severity: LintSeverity.Error,
      code: "non-ascii",
      message:
        `line ${i + 1} contains a ${name} character U+${code}` +
        `${count > 1 ? `, ${count} occurrences` : ""} — ORCA aborts on non-ASCII input; delete and retype the line`,
    });
  });
  if (extra > 0) {
    out.push({
      severity: LintSeverity.Error,
      code: "non-ascii",
      message: `…and ${extra} more lines with non-ASCII characters`,
    });
  }
  return out;
}
