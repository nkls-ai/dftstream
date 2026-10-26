/**
 * The ORCA keyword vocabulary the builder's linter knows, ported from
 * `inputparse` (the Go parser) so the browser flags the same typos the
 * CLI does.
 *
 * This is a typo detector, not a validator: ORCA's keyword space is huge
 * and version-dependent, so an unrecognized token alone is never worth a
 * warning. A finding fires only when a token sits within a small edit
 * distance of a keyword we know — the "Otp" → "OPT" class of mistake.
 */

const RUN_TYPES = [
  "SP", "ENERGY", "ENGRAD", "OPT", "OPTTS", "COPT", "GOAT", "MECP",
  "FREQ", "NUMFREQ", "ANFREQ",
  "NEB", "NEB-CI", "NEB-TS", "ZOOM-NEB", "ZOOM-NEB-CI", "ZOOM-NEB-TS", "NEB-IDPP",
  "FAST-NEB-TS", "LOOSE-NEB-TS", "TIGHT-NEB-TS",
  "IRC", "SCAN", "SCANTS", "MD", "PROPERTIES", "PROP",
  "TDDFT", "TDA", "CIS", "ESD", "NMR", "EPRNMR",
];

const SCF_TIERS = [
  "TIGHTSCF", "VERYTIGHTSCF", "STRONGSCF",
  "NORMALSCF", "LOOSESCF", "SLOPPYSCF", "EXTREMESCF",
];

const OPT_TIERS = ["TIGHTOPT", "VERYTIGHTOPT", "LOOSEOPT", "NORMALOPT"];

const GRIDS = ["DEFGRID1", "DEFGRID2", "DEFGRID3", "DEFGRID4"];

const CORRECTIONS = [
  "D2", "D3", "D3ZERO", "D3BJ", "D4",
  "GCP", "NOGCP", "NL", "VV10",
  "RIJCOSX", "RIJK", "NORI", "RI",
];

const SPIN_TAGS = ["UKS", "RKS", "ROKS", "UHF", "RHF", "ROHF"];

const WF_METHODS = [
  "HF", "MP2", "RI-MP2", "SCS-MP2", "DLPNO-MP2",
  "CCSD", "CCSD(T)", "DLPNO-CCSD", "DLPNO-CCSD(T)",
  "CASSCF", "NEVPT2", "CASPT2",
];

const TIGHT_BINDING = [
  "XTB", "XTB1", "XTB2",
  "GFN-XTB", "GFN1-XTB", "GFN2-XTB", "GFN-FF", "GFNFF",
  "PM3", "AM1", "MNDO", "PM6", "PM7",
];

const COMPOSITES = ["R2SCAN-3C", "B97-3C", "PBEH-3C", "HF-3C"];

const COMMON_FUNCTIONALS = [
  "B3LYP", "PBE0", "PBE", "TPSS", "TPSSH", "M06-2X",
  "WB97X-V", "WB97X-D3", "WB97X-D4", "CAM-B3LYP", "B2PLYP",
];

const COMMON_BASES = [
  "DEF2-SVP", "DEF2-SV(P)", "DEF2-TZVP", "DEF2-TZVPP", "DEF2-TZVPD",
  "DEF2-QZVP", "DEF2-QZVPP", "DEF2/J", "DEF2/JK",
  "CC-PVDZ", "CC-PVTZ", "CC-PVQZ",
];

const MISC = ["MINIPRINT", "NORMALPRINT", "LARGEPRINT", "PRINTBASIS", "NOAUTOSTART", "MOREAD", "AUTOAUX"];

const BASIS_PATTERNS = [
  /^(?:MA-)?DEF2-(?:M?SVP|SV\(P\)|TZVP|TZVPP|TZVPD|QZVP|QZVPP|QZVPPD|SVPD|TZVPPD)(?:-(?:F12|J|JK))?$/,
  /^(?:AUG-)?CC-PV[DTQ56]Z(?:-(?:F12|RI|PP|JK|C))?$/,
  /^(?:JUN|JUL|MAY|APR)-CC-PV[DTQ]Z$/,
  /^[3-6]-[23]1(?:1)?G(?:\*{1,2}|\(D\)|\(D,P\))?$/,
];

const FUNCTIONAL_SUBSTRINGS = [
  "BLYP", "BP86", "PBE0", "PBE", "B3LYP", "B3PW91", "BHANDHLYP",
  "M06", "M11", "MN15", "MN12", "WB97", "CAM-B3LYP",
  "R2SCAN", "SCAN", "TPSS", "B2PLYP", "DSD-PBEP86", "PWPB95",
  "OPBE", "OLYP", "REVPBE", "RPBE", "X3LYP", "HSE06",
];

const SOLVENT_CALL = /^(CPCM|SMD|ALPB|C-PCM)\(([^)]+)\)$/i;
const PAL_SHORT = /^PAL\d+$/;
const AUX_BASIS = /\/(J|JK|C)$/;

// --- Token classifiers -------------------------------------------------------
//
// Category tests over a single '!' token, shared with the advanced override
// panel: replacing "the preset's basis" requires recognizing which token IS
// the basis. Deliberately conservative — a token no test claims stays put.

const GRID_SET = new Set(GRIDS);
const SCF_TIER_SET = new Set(SCF_TIERS);
const DISPERSION_SET = new Set(["D2", "D3", "D3ZERO", "D3BJ", "D4", "NL"]);
const RI_SET = new Set(["RIJCOSX", "RIJK", "NORI", "RI"]);
const FUNCTIONAL_SET = new Set(COMMON_FUNCTIONALS);

/** Whether a token names an integration grid (DEFGRIDn). */
export function isGridToken(token: string): boolean {
  return GRID_SET.has(token.toUpperCase());
}

/** Whether a token names an SCF convergence tier. */
export function isScfTierToken(token: string): boolean {
  return SCF_TIER_SET.has(token.toUpperCase());
}

/** Whether a token names a dispersion correction (D3BJ, D4, NL, …). */
export function isDispersionToken(token: string): boolean {
  return DISPERSION_SET.has(token.toUpperCase());
}

/** Whether a token names an RI mode (RIJCOSX, RIJK, NORI, RI). */
export function isRIToken(token: string): boolean {
  return RI_SET.has(token.toUpperCase());
}

/** Whether a token names an auxiliary basis (…/J, …/JK, …/C). */
export function isAuxBasisToken(token: string): boolean {
  return AUX_BASIS.test(token.toUpperCase());
}

/** Whether a token names an orbital basis set (not an aux basis). */
export function isBasisToken(token: string): boolean {
  const up = token.toUpperCase();
  if (isAuxBasisToken(up)) return false;
  return COMMON_BASES.includes(up) || BASIS_PATTERNS.some((re) => re.test(up));
}

/**
 * Whether a token names a density functional. Composites (r2SCAN-3c…)
 * are excluded on purpose: they bundle their own basis and corrections,
 * so "override the functional" does not apply to them token-wise.
 */
export function isFunctionalToken(token: string): boolean {
  const up = token.toUpperCase();
  if (COMPOSITES.includes(up)) return false;
  return FUNCTIONAL_SET.has(up) || FUNCTIONAL_SUBSTRINGS.some((s) => up.includes(s));
}

const VOCABULARY: readonly string[] = [
  ...RUN_TYPES, ...SCF_TIERS, ...OPT_TIERS, ...GRIDS, ...CORRECTIONS,
  ...SPIN_TAGS, ...WF_METHODS, ...TIGHT_BINDING, ...COMPOSITES,
  ...COMMON_FUNCTIONALS, ...COMMON_BASES, ...MISC,
];

const KNOWN = new Set(VOCABULARY);

/** Whether a '!' token is one ORCA (and our parser) recognizes. */
export function isRecognizedToken(token: string): boolean {
  const up = token.toUpperCase();
  if (SOLVENT_CALL.test(token) || PAL_SHORT.test(up) || AUX_BASIS.test(up)) return true;
  if (KNOWN.has(up)) return true;
  if (BASIS_PATTERNS.some((re) => re.test(up))) return true;
  return FUNCTIONAL_SUBSTRINGS.some((s) => up.includes(s));
}

/**
 * Optimal-string-alignment distance: insert / delete / substitute plus
 * adjacent transposition, so the classic swapped-letters typo ("Otp")
 * counts as a single edit.
 */
export function osaDistance(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  let prev2: number[] = new Array(lb + 1).fill(0);
  let prev: number[] = Array.from({ length: lb + 1 }, (_, j) => j);
  let cur: number[] = new Array(lb + 1).fill(0);
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(cur[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, prev2[j - 2]! + 1);
      }
      cur[j] = best;
    }
    [prev2, prev, cur] = [prev, cur, prev2];
  }
  return prev[lb]!;
}

/**
 * The closest vocabulary word when it is close enough to be a plausible
 * typo: distance 1 always, distance 2 only for tokens of length ≥ 6
 * (short keywords at distance 2 are usually just different keywords).
 */
export function nearestKeyword(token: string): string | null {
  const up = token.toUpperCase();
  let best: string | null = null;
  let bestDist = 3;
  for (const word of VOCABULARY) {
    if (word === up) return null;
    if (Math.abs(word.length - up.length) >= bestDist) continue;
    const d = osaDistance(up, word);
    if (d < bestDist) {
      best = word;
      bestDist = d;
    }
  }
  const limit = up.length >= 6 ? 2 : 1;
  return best !== null && bestDist <= limit ? best : null;
}
