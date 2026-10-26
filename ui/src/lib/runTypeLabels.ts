// Display labels for ORCA job/run-type keywords. One map for every surface
// (experiment cards, keyword chips, run-detail header) — unknown types fall
// back to the raw keyword.
const RUN_TYPE_LABELS: Record<string, string> = {
  OPT: "Opt",
  COPT: "COpt",
  OPT_FREQ: "Opt+Freq",
  OPTTS: "OptTS",
  OPTTS_FREQ: "OptTS+Freq",
  SP: "SP",
  ENERGY: "Energy",
  ENGRAD: "EnGrad",
  FREQ: "Freq",
  NUMFREQ: "NumFreq",
  ANFREQ: "AnFreq",
  NEB: "NEB",
  "NEB-TS": "NEB-TS",
  "NEB-CI": "NEB-CI",
  SCAN: "Scan",
  IRC: "IRC",
  MECP: "MECP",
  GOAT: "GOAT",
  MD: "MD",
};

export function prettyRunType(t: string): string {
  return RUN_TYPE_LABELS[t] ?? t;
}
