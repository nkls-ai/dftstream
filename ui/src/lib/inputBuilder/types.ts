/**
 * The typed model of an ORCA input, mirroring
 * `wrapper/internal/inputbuild` so the browser builder and the Go
 * generators describe a job the same way (and, for the same job,
 * produce the same bytes).
 */

/** Job types the builder can construct. Ids match inputbuild.JobType. */
export enum JobTypeId {
  SP = "sp",
  Opt = "opt",
  OptFreq = "opt-freq",
  Freq = "freq",
  OptTS = "opt-ts",
  OptTSFreq = "opt-ts-freq",
  NEBTS = "neb-ts",
  NEBTSFreq = "neb-ts-freq",
  IRC = "irc",
  Goat = "goat",
  GoatEntropy = "goat-entropy",
  Scan = "scan",
  TDDFT = "tddft",
  NMR = "nmr",
  MECP = "mecp",
}

/** Implicit-solvation models. Ids match the `presets/solvents.v1.yaml` keys. */
export enum SolventModelId {
  None = "none",
  CPCM = "cpcm",
  SMD = "smd",
  ALPB = "alpb",
}

/** Method families, used to gate which solvent models apply. */
export enum MethodFamily {
  DFT = "dft",
  Composite = "composite",
  Wavefunction = "wavefunction",
  Semiempirical = "semiempirical",
}

/** Where a structure came from — shown to the user and written into the
 *  generated .xyz comment, so a geometry is never anonymous. */
export enum StructureSource {
  Pasted = "pasted",
  File = "file",
  Smiles = "smiles",
  /** Final geometry of a tracked run, picked from the history. */
  Run = "run",
}

export interface Atom {
  el: string;
  x: number;
  y: number;
  z: number;
}

export interface Structure {
  atoms: Atom[];
  source: StructureSource;
  /** Free-text provenance: file name, the SMILES, or "" for a paste. */
  label: string;
}

export interface JobTypeDef {
  id: JobTypeId;
  label: string;
  /** The '!' run keywords this job requests, in ORCA's usual order. */
  keywords: string[];
  description: string;
  needsFrequencies: boolean;
  /** NEB jobs need a second structure (the product endpoint). */
  needsEndpoint: boolean;
  /** Relaxed scans need a %geom Scan block (driven coordinate). */
  needsScan: boolean;
  /** TD-DFT jobs need a %tddft block (roots / triplets). */
  needsTddft: boolean;
  /** MECP searches need a %mecp block (the second state's multiplicity). */
  needsMecp: boolean;
}

/** Internal-coordinate kinds a relaxed scan can drive, spelled the way
 *  ORCA's `%geom Scan` section expects them. Mirrors inputbuild.ScanCoord. */
export enum ScanCoordId {
  Bond = "B",
  Angle = "A",
  Dihedral = "D",
}

/** Atom indices each scan coordinate takes (bond 2, angle 3, dihedral 4). */
export const SCAN_ATOM_COUNT: Readonly<Record<ScanCoordId, number>> = {
  [ScanCoordId.Bond]: 2,
  [ScanCoordId.Angle]: 3,
  [ScanCoordId.Dihedral]: 4,
};

/** One driven coordinate of a relaxed scan (`B 0 1 = 1.10, 1.80, 15`).
 *  Atom indices are ORCA's 0-based ones. */
export interface ScanSettings {
  coord: ScanCoordId;
  atoms: number[];
  from: number;
  to: number;
  steps: number;
}

/** The %tddft request of an absorption job. */
export interface TDDFTSettings {
  nroots: number;
  triplets: boolean;
}

/** The %mecp request: the second surface's multiplicity (2S+1). The
 *  first surface's multiplicity is the environment's own. */
export interface MECPSettings {
  mult2: number;
}

/** Thermochemistry conditions for the %freq block. 0 leaves the line out
 *  and keeps ORCA's own defaults (298.15 K, 1 atm). */
export interface ThermoSettings {
  temperatureK: number;
  pressureAtm: number;
}

export interface MethodPreset {
  id: string;
  label: string;
  family: MethodFamily;
  /** Method / basis / accuracy tokens — never a run keyword. */
  keywords: string[];
  /** Optimization tier (TightOpt …), substituted for a plain `Opt`. */
  optTier: string | null;
  defaultJob: JobTypeId;
  jobs: JobTypeId[];
  defaultSolventModel: SolventModelId;
  description: string;
  /** Times this keyword line appears in the lab's archived inputs. */
  observed: number | null;
}

export interface SolventModelDef {
  id: SolventModelId;
  /** Spelled exactly as it goes on the '!' line. */
  keyword: string;
  label: string;
  description: string;
  methodFamilies: MethodFamily[];
  solvents: string[];
}

/** Machine allocation. 0 leaves the corresponding line out entirely. */
export interface Resources {
  nprocs: number;
  maxCoreMB: number;
}

export interface Environment {
  charge: number;
  multiplicity: number;
  model: SolventModelId;
  solvent: string;
}

/** Everything the builder needs to render one input file. */
export interface InputSpec {
  keywords: string[];
  env: Environment;
  res: Resources;
  /** Extra `%…end` blocks, rendered verbatim in order. */
  blocks: string[];
  structure: Structure | null;
  /** When set, the structure is referenced as `* xyzfile … name`. */
  xyzFileName: string | null;
}

export const DEFAULT_ENVIRONMENT: Environment = {
  charge: 0,
  multiplicity: 1,
  model: SolventModelId.None,
  solvent: "",
};
