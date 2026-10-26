export type OrcaSyntaxMode = "input" | "output" | "xyz";

export interface OrcaToken {
  text: string;
  className?: string;
}

export interface OrcaHighlightedLine {
  tokens: OrcaToken[];
  className?: string;
}

const ELEMENTS = new Set(
  [
    "h", "he", "li", "be", "b", "c", "n", "o", "f", "ne", "na", "mg",
    "al", "si", "p", "s", "cl", "ar", "k", "ca", "sc", "ti", "v", "cr",
    "mn", "fe", "co", "ni", "cu", "zn", "ga", "ge", "as", "se", "br",
    "kr", "rb", "sr", "y", "zr", "nb", "mo", "tc", "ru", "rh", "pd",
    "ag", "cd", "in", "sn", "sb", "te", "i", "xe", "cs", "ba", "la",
    "ce", "pr", "nd", "pm", "sm", "eu", "gd", "tb", "dy", "ho", "er",
    "tm", "yb", "lu", "hf", "ta", "w", "re", "os", "ir", "pt", "au",
    "hg", "tl", "pb", "bi", "po", "at", "rn", "fr", "ra", "ac", "th",
    "pa", "u", "np", "pu",
  ],
);

const INPUT_BLOCKS = new Set(
  [
    "autoci", "basis", "casscf", "cim", "cipsi", "compound", "coords",
    "cpcm", "elprop", "eprnmr", "freq", "geom", "loc", "md", "mdci",
    "method", "mp2", "mrci", "mrpt", "moinp", "output", "pal", "paras",
    "plots", "rel", "rocis", "scf", "solvator", "tddft", "time",
    "maxcore", "pointcharges", "symmetry", "cosmo", "qmmm", "esd", "goat",
    "neb", "ci", "cisd", "numfreq",
  ],
);

const SIMPLE_KEYWORDS = new Set(
  [
    "sp", "opt", "optts", "freq", "anfreq", "numfreq", "scan", "neb",
    "irc", "md", "goat", "b3lyp", "blyp", "pbe", "pbe0", "bp86", "tpss",
    "tpssh", "m06", "m062x", "wb97x", "wb97x-d3", "cam-b3lyp", "hf",
    "rhf", "uhf", "rohf", "mp2", "ri-mp2", "dlpno-mp2", "ccsd",
    "ccsd(t)", "dlpno-ccsd", "dlpno-ccsd(t)", "casscf", "nevlpt2", "ci",
    "tddft", "cisd", "zora", "dkh", "riscosx", "rijcosx", "ri", "noautostart",
    "moread", "tightscf", "verytightscf", "sloppy", "normalprint",
    "largeprint", "miniprint", "grid1", "grid2", "grid3", "grid4", "grid5",
    "defgrid1", "defgrid2", "defgrid3", "defgrid4", "defgrid5", "finalgrid6",
    "d3", "d3bj", "d4", "nl", "cpcm", "smd", "cosmo", "def2-svp",
    "def2-svpp", "def2-tzvp", "def2-tzvpp", "def2-qzvp", "ma-def2-svp",
    "ma-def2-tzvp", "aug-cc-pvdz", "aug-cc-pvtz", "cc-pvdz", "cc-pvtz",
    "svp", "tzvp", "tzvpp", "qzvp", "sto-3g", "minao", "autoaux",
  ],
);

const METHOD_KEYWORDS = new Set(
  [
    "b3lyp", "blyp", "pbe", "pbe0", "bp86", "tpss", "tpssh", "m06",
    "m062x", "wb97x", "wb97x-d3", "cam-b3lyp", "hf", "rhf", "uhf",
    "rohf", "mp2", "ri-mp2", "dlpno-mp2", "ccsd", "ccsd(t)",
    "dlpno-ccsd", "dlpno-ccsd(t)", "casscf", "nevlpt2", "tddft",
  ],
);

const BASIS_KEYWORDS = new Set(
  [
    "def2-svp", "def2-svpp", "def2-tzvp", "def2-tzvpp", "def2-qzvp",
    "ma-def2-svp", "ma-def2-tzvp", "aug-cc-pvdz", "aug-cc-pvtz",
    "cc-pvdz", "cc-pvtz", "svp", "tzvp", "tzvpp", "qzvp", "sto-3g",
    "minao", "autoaux",
  ],
);

const INPUT_PROPERTIES = new Set(
  [
    "end", "true", "false", "on", "off", "nprocs", "nproc", "maxiter",
    "charge", "mult", "maxcore", "tol", "tolenergy", "tolrmsg", "convergence",
    "conv", "solvent", "epsilon", "refrac", "grid", "finalgrid", "printlevel",
    "coords", "coordstype", "units", "typ", "newgto", "aux", "auxj",
    "auxjk", "decontract", "tight", "diis", "soscf", "shift", "hessname",
    "xyzfile", "xyz", "int", "gzmt", "constraints", "scan", "frags",
    "orbwin", "nroots", "iroot", "triplets", "dosoc", "nel", "norb",
  ],
);

const OUTPUT_TERMS = new Set(
  [
    "orca", "input", "file", "program", "version", "final", "single",
    "point", "energy", "total", "scf", "iterations", "converged",
    "optimization", "cycle", "geometry", "frequencies", "normal", "modes",
    "mulliken", "loewdin", "charges", "dipole", "orbitals", "population",
    "basis", "set", "coordinates", "cartesian", "runtime", "wall", "time",
    "terminated", "normally", "warning", "error", "aborting", "failed",
  ],
);

const OUTPUT_SECTION_PATTERNS = [
  /^INPUT FILE$/,
  /^CARTESIAN COORDINATES(?:\s+\([^)]+\))?$/,
  /^INTERNAL COORDINATES$/,
  /^BASIS SET INFORMATION$/,
  /^SCF ITERATIONS$/,
  /^ORBITAL ENERGIES$/,
  /^MOLECULAR ORBITALS$/,
  /^GEOMETRY OPTIMIZATION(?:\s+CYCLE\s+\d+)?$/,
  /^VIBRATIONAL FREQUENCIES$/,
  /^NORMAL MODES$/,
  /^IR SPECTRUM$/,
  /^RAMAN SPECTRUM$/,
  /^THERMOCHEMISTRY(?:\s+AT\s+.+)?$/,
  /^MULLIKEN ATOMIC CHARGES$/,
  /^LOEWDIN ATOMIC CHARGES$/,
  /^HIRSHFELD ANALYSIS$/,
  /^MAYER POPULATION ANALYSIS$/,
  /^ORCA PROPERTY CALCULATIONS$/,
  /^DIPOLE MOMENT$/,
  /^TD-DFT\/TDA EXCITED STATES$/,
  /^ELECTRIC PROPERTIES$/,
  /^TIMINGS$/,
  /^STARTING AUTOMATIC FRAGMENTATION:?$/,
  /^GEOMETRY OPTIMIZATION RUN$/,
  /^ORCA OPTIMIZATION COORDINATE SETUP$/,
  /^ORCA GEOMETRY RELAXATION STEP$/,
  /^GEOMETRY CONVERGENCE$/,
  /^GLOBAL PARAMETERS$/,
  /^FILTERING CRITERIA$/,
  /^THERMODYNAMICS$/,
  /^TIMINGS FOR INDIVIDUAL MODULES:?$/,
  /^SPIN CONTAMINATION$/,
  /^DISPERSION CORRECTION$/,
  /^ABSORPTION SPECTRUM/,
  /^CD SPECTRUM/,
  /^CHEMICAL SHIELDING/,
  /^NPA CHARGES$/,
  /^NATURAL BOND ORBITAL ANALYSIS$/,
  /^MAYER BOND ORDERS$/,
  /^QUADRUPOLE MOMENT$/,
  /^ROTATIONAL SPECTRUM$/,
  /^TOTAL SCF ENERGY$/,
  /^DFT DISPERSION CORRECTION$/,
];

const UNITS = new Set(
  ["eh", "ev", "cm-1", "kcal/mol", "kj/mol", "au", "debye", "ang", "angstrom", "fs", "ps", "sec", "s", "min", "h"],
);

const TOKEN_RE =
  /(\s+|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[EeDd][-+]?\d+)?|[!%*#=(),;:[\]{}<>/+^-]|\b[A-Za-z][A-Za-z0-9_.-]*\b|.)/g;

export function highlightOrcaLine(
  line: string,
  mode: OrcaSyntaxMode,
): OrcaHighlightedLine {
  if (mode === "input") return highlightInputLine(line);
  if (mode === "xyz") return highlightXYZLine(line);
  return highlightOutputLine(line);
}

function highlightInputLine(line: string): OrcaHighlightedLine {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("#") || trimmed.startsWith("//")) {
    return { className: "orca-line-comment", tokens: [{ text: line, className: "orca-comment" }] };
  }

  const commentIdx = line.indexOf("#");
  if (commentIdx >= 0) {
    return {
      className: inputLineClass(line),
      tokens: [
        ...tokenize(line.slice(0, commentIdx), "input"),
        { text: line.slice(commentIdx), className: "orca-comment" },
      ],
    };
  }

  return { className: inputLineClass(line), tokens: tokenize(line, "input") };
}

function inputLineClass(line: string): string | undefined {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("!")) return "orca-line-input-simple";
  if (/^%\w+/.test(trimmed)) return "orca-line-input-block";
  if (/^\*\s*(?:xyz|int|gzmt|xyzfile)\b/i.test(trimmed)) return "orca-line-input-coords";
  if (/^\*\s*$/.test(trimmed)) return "orca-line-input-coords";
  if (/^\s*(?:[A-Z][a-z]?|\d+)\s+[-+]?(?:\d|\.)/.test(line)) return "orca-line-input-atom";
  return undefined;
}

function highlightOutputLine(line: string): OrcaHighlightedLine {
  const upper = line.toUpperCase();
  const className = outputLineClass(line, upper);
  return { className, tokens: tokenizeOutput(line, className) };
}

function highlightXYZLine(line: string): OrcaHighlightedLine {
  const trimmed = line.trim();
  const className = xyzLineClass(line, trimmed);
  return { className, tokens: tokenizeXYZ(line, className) };
}

function xyzLineClass(line: string, trimmed: string): string | undefined {
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) return "orca-line-xyz-count";
  if (/^\s*[A-Z][a-z]?(?:\s+[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[EeDd][-+]?\d+)?){3,}(?:\s+.*)?$/.test(line)) {
    return "orca-line-xyz-atom";
  }
  return "orca-line-xyz-comment";
}

function outputLineClass(line: string, upper: string): string | undefined {
  const normalized = upper.trim().replace(/\s+/g, " ");
  if (/^\s*(?:[-=*]{5,}|\*{5,})\s*$/.test(line)) return "orca-line-output-rule";
  if (/ORCA TERMINATED NORMALLY/.test(upper)) return "orca-line-output-success";
  if (/\b(?:ERROR|FAILED|ABORT|TERMINATED ABNORMALLY)\b/.test(upper)) return "orca-line-output-error";
  if (/^\s*(?:WARNING|WARNINGS|CAUTION)\b/.test(upper)) return "orca-line-output-warning";
  if (/FINAL SINGLE POINT ENERGY|^\s*TOTAL ENERGY\s*:|E\(0\)|E\(CORR\)|CORRELATION ENERGY/.test(upper)) return "orca-line-output-energy";
  if (/^\s*(?:CURRENT ENERGY|THE PREDICTED ENERGY CHANGE IS|PREVIOUSLY PREDICTED ENERGY CHANGE|ACTUALLY OBSERVED ENERGY CHANGE|LOWEST ENERGY CONFORMER)\b/.test(upper)) return "orca-line-output-energy";
  if (/^\s*(?:DISPERSION CORRECTION|VAN DER WAALS CORRECTION|DFT-D[234] CORRECTION)\b/.test(upper)) return "orca-line-output-energy";
  if (/^\s*<S\*\*2>\s*=|IDEAL VALUE\s*=|SPIN CONTAMINATION/.test(upper)) return "orca-line-output-spin";
  if (/^\s*(?:HOMO|LUMO)\b.*[-+]?\d/.test(upper) || /HOMO-LUMO GAP/.test(upper)) return "orca-line-output-orbital";
  if (/^\s*(?:GIBBS FREE ENERGY|TOTAL ENTHALPY|TOTAL ENTROPY|ZERO POINT ENERGY|THERMAL CORRECTION|INNER ENERGY)\b/.test(upper)) return "orca-line-output-thermo";
  if (/^\s*(?:N\(Alpha\)|N\(Beta\)|TOTAL SPIN|Magnitude\s*\(Debye\))\b/.test(upper)) return "orca-line-output-property";
  if (/^\s*T1 DIAGNOSTIC\b/.test(upper)) return "orca-line-output-spin";
  if (/^\s*(?:ABSORPTION SPECTRUM|CD SPECTRUM)\b/.test(upper)) return "orca-line-output-section";
  if (/^\s*(?:CHEMICAL SHIELDING|NMR SHIELDING)\b/.test(upper)) return "orca-line-output-property";
  if (/^\s*(?:NUMBER OF BASIS FUNCTIONS|TOTAL NUMBER OF PRIMITIVE)\b/.test(upper)) return "orca-line-output-property";
  if (/^\s*NUCLEAR REPULSION\s*:/i.test(upper)) return "orca-line-output-energy";
  if (/SCF CONVERGED|^\s*SCF ITERATIONS\s*$|^\s*CONVERGENCE CHECK/.test(upper)) return "orca-line-output-scf";
  if (/GEOMETRY OPTIMIZATION|OPTIMIZATION CYCLE|THE OPTIMIZATION HAS CONVERGED/.test(upper)) return "orca-line-output-opt";
  if (/OPTIMIZATION RUN DONE|GLOBAL MINIMUM FOUND/.test(upper)) return "orca-line-output-success";
  if (/^\s*(?:ENERGY CHANGE|RMS GRADIENT|MAX GRADIENT|RMS STEP|MAX STEP)\s+[-+]?\d/.test(upper)) return "orca-line-output-convergence";
  if (/^\s*(?:\d+\s*:)?\s*[-+]?\d+\.\d+\s*cm\*\*-1\b/i.test(line)) return "orca-line-output-freq";
  if (/^\s*(?:VIBRATIONAL FREQUENCIES|NORMAL MODES|IR SPECTRUM|RAMAN SPECTRUM)\s*$/.test(upper)) return "orca-line-output-freq";
  if (/^\s*(?:MULLIKEN|LOEWDIN|HIRSHFELD|CHELPG|DIPOLE|MAYER)\b/.test(upper)) return "orca-line-output-property";
  if (/^\s*(?:ORBITAL ENERGIES|MOLECULAR ORBITALS)\s*$/.test(upper)) return "orca-line-output-orbital";
  if (/TOTAL RUN TIME|^\s*TIMINGS\s*$|^\s*ELAPSED\b|^\s*(?:SUM OF INDIVIDUAL TIMES|GEOMETRY RELAXATION|GOAT|XTB MODULE)\s+\.\.\./.test(upper)) return "orca-line-output-time";
  if (/^\s*\*?\s*GOAT\s*\*?\s*$|^\s*GOAT GLOBAL ITER\s+\d+\s*$/.test(upper)) return "orca-line-output-goat";
  if (/^\s*(?:GOAT VERSION|MINIMUM GLOBAL STEPS|NUMBER OF BASE WORKERS|FINAL NUMBER OF WORKERS|NUMBER OF AVAILABLE CPUS|NUMBER OF FRAGMENTS|FLEXIBILITY PARAMETER|OPTIMIZATIONS PER GLOBAL STEP|OPTIMIZATIONS PER WORKER|MAXIMUM CONF\. ENERGY|ENSEMBLE TEMPERATURE|MINIMUM SCONF DIFFERENCE|DEGENERACY OF CONFORMERS|LIST OF PARTICIPATING NODES)\b/.test(upper)) return "orca-line-output-goat";
  if (/FINAL ENSEMBLE INFO|^\s*CONFORMER\s+ENERGY\b|CONFORMERS BELOW|SCONF AT|GCONF AT|WRITING (?:STRUCTURE|FINAL ENSEMBLE)/.test(upper)) return "orca-line-output-goat-result";
  if (/^\s*\d+\s+[-+]?\d+\.\d+\s+\d+\s+[-+]?\d+\.\d+\s+[-+]?\d+\.\d+/.test(line)) return "orca-line-output-goat-result";
  if (/^\s*\d+\s+-\d+\.\d+\s+[-+]?\d+\.\d+\s+[-+]?\d+\.\d+\s*$/.test(line)) return "orca-line-output-goat-result";
  if (OUTPUT_SECTION_PATTERNS.some((re) => re.test(normalized))) return "orca-line-output-section";
  return undefined;
}

function tokenize(line: string, mode: OrcaSyntaxMode): OrcaToken[] {
  const tokens: OrcaToken[] = [];
  TOKEN_RE.lastIndex = 0;
  for (const match of line.matchAll(TOKEN_RE)) {
    const text = match[0];
    tokens.push({ text, className: classifyToken(text, mode) });
  }
  return tokens.length > 0 ? tokens : [{ text: "" }];
}

function tokenizeOutput(line: string, lineClass?: string): OrcaToken[] {
  if (!lineClass || lineClass === "orca-line-output-rule" || lineClass === "orca-line-output-section") {
    return plainTokens(line);
  }

  const tokens: OrcaToken[] = [];
  TOKEN_RE.lastIndex = 0;
  for (const match of line.matchAll(TOKEN_RE)) {
    const text = match[0];
    tokens.push({ text, className: classifyOutputToken(text, lineClass) });
  }
  return tokens.length > 0 ? tokens : [{ text: "" }];
}

function tokenizeXYZ(line: string, lineClass?: string): OrcaToken[] {
  if (!lineClass) return plainTokens(line);
  const tokens: OrcaToken[] = [];
  TOKEN_RE.lastIndex = 0;
  for (const match of line.matchAll(TOKEN_RE)) {
    const text = match[0];
    tokens.push({ text, className: classifyXYZToken(text, lineClass) });
  }
  return tokens.length > 0 ? tokens : [{ text: "" }];
}

function plainTokens(line: string): OrcaToken[] {
  return line ? [{ text: line }] : [{ text: "" }];
}

function classifyToken(text: string, mode: OrcaSyntaxMode): string | undefined {
  if (/^\s+$/.test(text)) return undefined;
  if (/^["']/.test(text)) return "orca-string";
  if (/^[-+]?(?:\d|\.)/.test(text)) return "orca-number";
  if (/^[!%*#=(),;:[\]{}<>/+^-]$/.test(text)) return "orca-operator";

  const lower = text.toLowerCase();
  if (ELEMENTS.has(lower)) return "orca-element";
  if (mode === "input") {
    if (INPUT_BLOCKS.has(lower)) return "orca-block";
    if (INPUT_PROPERTIES.has(lower)) return lower === "end" ? "orca-end" : "orca-property";
    if (METHOD_KEYWORDS.has(lower)) return "orca-method";
    if (BASIS_KEYWORDS.has(lower)) return "orca-basis";
    if (SIMPLE_KEYWORDS.has(lower)) return "orca-keyword";
    if (/^[a-z][a-z0-9_.-]*$/i.test(text)) return "orca-identifier";
  } else {
    return undefined;
  }
  return undefined;
}

function classifyOutputToken(text: string, lineClass: string): string | undefined {
  if (/^\s+$/.test(text)) return undefined;
  if (/^[-+]?(?:\d|\.)/.test(text)) return outputNumberClass(lineClass);
  if (/^[=(),;:[\]{}<>/+^-]$/.test(text)) return "orca-operator";

  const lower = text.toLowerCase();
  if (lineClass === "orca-line-output-coord" || lineClass === "orca-line-output-table") {
    if (ELEMENTS.has(lower)) return "orca-element";
    return undefined;
  }
  if (UNITS.has(lower)) return "orca-unit";
  if (/^(warning|warnings|caution|error|failed|abort|aborting)$/i.test(text)) return "orca-status-bad";
  if (/^NO$/i.test(text) && lineClass === "orca-line-output-convergence") return "orca-status-bad";
  if (/^YES$/i.test(text) && lineClass === "orca-line-output-convergence") return "orca-status-good";
  if (/^(converged|terminated|normally)$/i.test(text)) return "orca-status-good";
  if (
    lineClass === "orca-line-output-energy" &&
    /^(final|single|point|total|energy|correlation|dispersion|correction|nuclear|repulsion)$/i.test(text)
  ) {
    return "orca-energy-label";
  }
  if (
    lineClass === "orca-line-output-spin" &&
    /^(s\*\*2|ideal|contamination|t1|diagnostic)$/i.test(text)
  ) {
    return "orca-energy-label";
  }
  if (
    lineClass === "orca-line-output-thermo" &&
    /^(gibbs|free|enthalpy|entropy|zero|point|thermal|inner|correction)$/i.test(text)
  ) {
    return "orca-energy-label";
  }
  if (
    lineClass === "orca-line-output-orbital" &&
    /^(homo|lumo|gap)$/i.test(text)
  ) {
    return "orca-energy-label";
  }
  if (OUTPUT_TERMS.has(lower)) return "orca-output-keyword";
  if (/^(goat|global|iter|conformer|conformers|sconf|gconf|ensemble|minimum|workers|atoms)$/i.test(text)) return "orca-output-keyword";
  return undefined;
}

function classifyXYZToken(text: string, lineClass: string): string | undefined {
  if (/^\s+$/.test(text)) return undefined;
  if (/^[-+]?(?:\d|\.)/.test(text)) return "orca-number";
  if (/^[=(),;:[\]{}<>/+^-]$/.test(text)) return "orca-operator";
  const lower = text.toLowerCase();
  if (ELEMENTS.has(lower)) return "orca-element";
  if (
    lineClass === "orca-line-xyz-comment" &&
    /^(energy|frame|step|cycle|mode|freq|frequency|charge|mult|comment)$/i.test(text)
  ) {
    return "orca-output-keyword";
  }
  return undefined;
}

function outputNumberClass(lineClass: string): string | undefined {
  switch (lineClass) {
    case "orca-line-output-energy":
    case "orca-line-output-freq":
    case "orca-line-output-property":
    case "orca-line-output-orbital":
    case "orca-line-output-time":
    case "orca-line-output-convergence":
    case "orca-line-output-goat":
    case "orca-line-output-goat-result":
    case "orca-line-output-spin":
    case "orca-line-output-thermo":
      return "orca-number";
    default:
      return undefined;
  }
}
