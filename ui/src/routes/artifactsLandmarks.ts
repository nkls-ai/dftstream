import { EMPTY_ENERGY, formatEh } from "../lib/energyUnits";
import { DEFAULT_SETTINGS } from "../lib/settingsSchema";
export type LandmarkKind =
  | "input"
  | "optCycle"
  | "scfIter"
  | "scfConverged"
  | "totalEnergy"
  | "finalSp"
  | "convergedOpt"
  | "freqs"
  | "normalModes"
  | "props"
  | "mulliken"
  | "loewdin"
  | "terminated"
  | "runtime"
  | "spinContamination"
  | "dispersion"
  | "homoLumo"
  | "thermo"
  | "dipole"
  | "excitedStates"
  | "nmrShielding"
  | "mayer"
  | "t1diagnostic"
  | "basisInfo";

export interface Landmark {
  lineIdx: number;
  label: string;
  kind: LandmarkKind;
  cycle?: number;
}

export interface LandmarkNode extends Landmark {
  children: LandmarkNode[];
  flags: { finalConverged?: boolean; convergedCycle?: boolean };
}

const LANDMARK_PATTERNS: {
  re: RegExp;
  /** `eh` formats a captured absolute energy at the user's precision. */
  build: (m: RegExpMatchArray, eh: (s: string) => string) => Omit<Landmark, "lineIdx">;
}[] = [
  {
    re: /^INPUT FILE\s*$/,
    build: () => ({ kind: "input", label: "Input file" }),
  },
  {
    re: /\bGEOMETRY OPTIMIZATION CYCLE\s+(\d+)/,
    build: (m) => ({
      kind: "optCycle",
      label: `Opt cycle ${m[1] ?? "?"}`,
      cycle: Number(m[1] ?? 0),
    }),
  },
  {
    re: /^\s*SCF ITERATIONS\s*$/,
    build: () => ({ kind: "scfIter", label: "SCF iterations" }),
  },
  {
    re: /SCF CONVERGED AFTER\s+(\d+)\s+CYCLES/i,
    build: (m) => ({
      kind: "scfConverged",
      label: `SCF converged (${m[1] ?? "?"} iter)`,
    }),
  },
  {
    re: /SCF CONVERGED AFTER/,
    build: () => ({ kind: "scfConverged", label: "SCF converged" }),
  },
  {
    re: /THE OPTIMIZATION HAS CONVERGED/,
    build: () => ({ kind: "convergedOpt", label: "OPTIMIZATION CONVERGED" }),
  },
  {
    re: /FINAL SINGLE POINT ENERGY\s+([-\d.E+]+)/i,
    build: (m, eh) => ({
      kind: "finalSp",
      label: `Final SP · ${eh(m[1] ?? "")} Eh`,
    }),
  },
  {
    re: /VIBRATIONAL FREQUENCIES/,
    build: () => ({ kind: "freqs", label: "Vibrational frequencies" }),
  },
  {
    re: /^\s*NORMAL MODES\s*$/,
    build: () => ({ kind: "normalModes", label: "Normal modes" }),
  },
  {
    re: /ORCA PROPERTY CALCULATIONS/,
    build: () => ({ kind: "props", label: "Property calculations" }),
  },
  {
    re: /MULLIKEN ATOMIC CHARGES/,
    build: () => ({ kind: "mulliken", label: "Mulliken charges" }),
  },
  {
    re: /LOEWDIN ATOMIC CHARGES/,
    build: () => ({ kind: "loewdin", label: "Loewdin charges" }),
  },
  {
    re: /^Total Energy\s*:\s*([-\d.E+]+)\s*Eh/i,
    build: (m, eh) => ({
      kind: "totalEnergy",
      label: `Total energy · ${eh(m[1] ?? "")} Eh`,
    }),
  },
  {
    re: /^Total Energy\s*:/,
    build: () => ({ kind: "totalEnergy", label: "Total energy" }),
  },
  {
    re: /ORCA TERMINATED NORMALLY/,
    build: () => ({ kind: "terminated", label: "Terminated normally" }),
  },
  {
    re: /TOTAL RUN TIME/,
    build: () => ({ kind: "runtime", label: "Total run time" }),
  },
  {
    re: /<S\*\*2>\s*=\s*([-\d.]+)/,
    build: (m) => ({ kind: "spinContamination", label: `<S**2> = ${m[1] ?? "?"}` }),
  },
  {
    re: /T1 DIAGNOSTIC\s*=?\s*([-\d.]+)/i,
    build: (m) => ({ kind: "t1diagnostic", label: `T1 diagnostic = ${m[1] ?? "?"}` }),
  },
  {
    re: /^\s*(?:DFT )?DISPERSION CORRECTION/i,
    build: () => ({ kind: "dispersion", label: "Dispersion correction" }),
  },
  {
    re: /^\s*ORBITAL ENERGIES\s*$/,
    build: () => ({ kind: "homoLumo", label: "Orbital energies (HOMO/LUMO)" }),
  },
  {
    re: /^\s*THERMOCHEMISTRY/i,
    build: () => ({ kind: "thermo", label: "Thermochemistry" }),
  },
  {
    re: /GIBBS FREE ENERGY\s*:\s*([-\d.]+)/i,
    build: (m, eh) => ({ kind: "thermo", label: `Gibbs free energy · ${eh(m[1] ?? "")} Eh` }),
  },
  {
    re: /^\s*DIPOLE MOMENT\s*$/,
    build: () => ({ kind: "dipole", label: "Dipole moment" }),
  },
  {
    re: /Magnitude\s*\(Debye\)\s*:\s*([-\d.]+)/,
    build: (m) => ({ kind: "dipole", label: `Dipole · ${Number(m[1] ?? 0).toFixed(4)} D` }),
  },
  {
    re: /ABSORPTION SPECTRUM VIA TRANSITION/,
    build: () => ({ kind: "excitedStates", label: "UV-Vis absorption spectrum" }),
  },
  {
    re: /TD-DFT\/TDA EXCITED STATES/,
    build: () => ({ kind: "excitedStates", label: "TD-DFT excited states" }),
  },
  {
    re: /CHEMICAL SHIELDING/,
    build: () => ({ kind: "nmrShielding", label: "NMR chemical shielding" }),
  },
  {
    re: /MAYER POPULATION ANALYSIS/,
    build: () => ({ kind: "mayer", label: "Mayer bond orders" }),
  },
  {
    re: /^\s*NUMBER OF BASIS FUNCTIONS\s*:\s*(\d+)/,
    build: (m) => ({ kind: "basisInfo", label: `Basis functions: ${m[1] ?? "?"}` }),
  },
];

const TOP_LEVEL: Record<LandmarkKind, boolean> = {
  input: true,
  optCycle: true,
  convergedOpt: true,
  spinContamination: true,
  dispersion: true,
  homoLumo: true,
  thermo: true,
  dipole: true,
  excitedStates: true,
  nmrShielding: true,
  mayer: true,
  t1diagnostic: true,
  basisInfo: false,
  freqs: true,
  normalModes: true,
  props: true,
  mulliken: true,
  loewdin: true,
  terminated: true,
  runtime: true,
  scfIter: false,
  scfConverged: false,
  totalEnergy: false,
  finalSp: false,
};

export function findLandmarks(
  lines: string[],
  energyDecimals: number = DEFAULT_SETTINGS.energyDecimals,
): Landmark[] {
  const eh = (s: string) => formatEnergy(s, energyDecimals);
  const out: Landmark[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const p of LANDMARK_PATTERNS) {
      const m = line.match(p.re);
      if (m) {
        out.push({ lineIdx: i, ...p.build(m, eh) });
        break;
      }
    }
  }
  return out;
}

export function buildTree(landmarks: Landmark[]): LandmarkNode[] {
  const out: LandmarkNode[] = [];
  let currentParent: LandmarkNode | null = null;
  let lastOptCycle: LandmarkNode | null = null;
  let optConvergedSeen = false;
  let convergedNode: LandmarkNode | null = null;

  for (const lm of landmarks) {
    const node: LandmarkNode = { ...lm, children: [], flags: {} };

    if (lm.kind === "convergedOpt") {
      if (lastOptCycle) lastOptCycle.flags.convergedCycle = true;
      optConvergedSeen = true;
      convergedNode = node;
      out.push(node);
      currentParent = node;
      continue;
    }

    if (TOP_LEVEL[lm.kind]) {
      out.push(node);
      if (lm.kind === "optCycle") {
        currentParent = node;
        lastOptCycle = node;
      } else {
        currentParent = null;
      }
      continue;
    }

    if (optConvergedSeen && lm.kind === "finalSp" && convergedNode) {
      node.flags.finalConverged = true;
      convergedNode.children.push(node);
      currentParent = convergedNode;
      continue;
    }

    if (currentParent) {
      currentParent.children.push(node);
    } else {
      out.push(node);
    }
  }
  return out;
}

/** A captured energy string at `decimals`; non-numeric captures pass through verbatim. */
export function formatEnergy(s: string, decimals: number): string {
  if (!s.trim()) return EMPTY_ENERGY;
  const n = Number(s);
  return Number.isFinite(n) ? formatEh(n, decimals) : s;
}
