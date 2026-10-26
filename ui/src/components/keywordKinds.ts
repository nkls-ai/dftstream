/** Run-keyword classification helpers shared by the chip components. */

export type ChipKind =
  | "opt"
  | "optts"
  | "freq"
  | "sp"
  | "neb"
  | "irc"
  | "scan"
  | "goat"
  | "scf"
  | "func"
  | "basis"
  | "solvent"
  | "corr"
  | "method"
  | "xtb"
  | "default";

const XTB_METHODS = new Set([
  "XTB", "XTB1", "XTB2",
  "GFN-XTB", "GFN1-XTB", "GFN2-XTB",
  "GFN-FF", "GFNFF",
]);

export function isXtbMethod(method: string | undefined): boolean {
  return !!method && XTB_METHODS.has(method.toUpperCase());
}

const RUNTYPE_KIND: Record<string, ChipKind> = {
  OPT: "opt",
  COPT: "opt",
  OPTTS: "optts",
  FREQ: "freq",
  NUMFREQ: "freq",
  ANFREQ: "freq",
  SP: "sp",
  ENGRAD: "sp",
  ENERGY: "sp",
  NEB: "neb",
  "NEB-CI": "neb",
  "NEB-TS": "neb",
  IRC: "irc",
  SCAN: "scan",
  MD: "scan",
  GOAT: "goat",
};

export function runTypeKind(t: string): ChipKind {
  return RUNTYPE_KIND[t] ?? "default";
}
