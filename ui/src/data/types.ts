// Backend-agnostic view types. Implementations of DataSource normalize
// their native row shapes to these.

export const RUN_STATUSES = ["pending", "running", "finished", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface Experiment {
  id: string;
  name: string;
  createdAt: number;
}

export interface ExperimentSummary extends Experiment {
  runCount: number;
  // True when runCount hit the backend's per-summary read cap and the real
  // total may be higher; render as "N+".
  runCountCapped?: boolean;
  // True when the backend has no rollup for this experiment yet (it predates
  // the rollup and the backfill has not reached it). The tallies are absent,
  // not zero — render them as "—" rather than as an empty experiment.
  summaryPending?: boolean;
  running: number;
  finished: number;
  failed: number;
  lastActivity: number;
  latestStatus?: RunStatus;
  latestRunName?: string;
  latestRunId?: string;
  latestLastEnergy?: number;
  topFunctional?: string;
  topBasis?: string;
  topRunType?: string;
}

export interface Batch {
  id: string;
  experimentId: string;
  name: string;
  description?: string;
  artifactLevel?: string;
  createdAt: number;
}

/** Denormalized per-batch tallies (the `batchProgress` table). Every headline
 *  figure on the batch dashboard comes from here, so a batch of any size costs
 *  one document to read instead of a scan over its runs. Sums rather than
 *  samples: mean and spread (and thus an ETA range) are derived, and
 *  `coreSecondsSum` is Σ wallclock × nprocs. */
export interface BatchProgress {
  batchId: string;
  experimentId: string;

  total: number;
  pending: number;
  running: number;
  finished: number;
  failed: number;

  converged: number;
  notConverged: number;
  optMaxCycles: number;
  withImaginary: number;
  missingThermo: number;
  suspicious: number;

  wallclockSumSec: number;
  wallclockSumSqSec: number;
  coreSecondsSum: number;
  firstStartedAt?: number;
  lastFinishedAt?: number;

  minEnergyEh?: number;
  energySumEh: number;
  energyCount: number;

  /** ERROR_CLASS member → count. */
  failureCounts: Record<string, number>;

  updatedAt: number;
}

export interface Run {
  id: string;
  experimentId: string;
  batchId?: string;
  batchParams?: Record<string, string | number | boolean>;
  name?: string;
  status: RunStatus;
  exitCode?: number;
  hostname?: string;
  ncores?: number;
  nprocs?: number;
  maxcoreMb?: number;
  orcaVersion?: string;
  jobType?: string;
  inputPath?: string;
  inputText?: string;
  cwd?: string;
  startedAt: number;
  finishedAt?: number;
  lastEnergy?: number;
  /** Wallclock duration in seconds as reported by ORCA's
   *  "TOTAL RUN TIME:" line. Preferred over finishedAt-startedAt
   *  because for imports startedAt is just the .out mtime. */
  wallclockSec?: number;

  // Parsed from the ORCA simple-input ('!') line(s).
  keywords?: string[];
  functional?: string;
  basis?: string;
  method?: string;
  runTypes?: string[];
  scfTier?: string;
  optTier?: string;
  grid?: string;
  solvent?: string;
  solventModel?: string;
  corrections?: string[];
  charge?: number;
  mult?: number;
  converged?: boolean;
  /** Optimizer stopped at the cycle limit (stalled, not crashed). */
  optMaxCycles?: boolean;
  imaginaryModes?: number;

  // Thermochemistry (all Hartree), from the last THERMOCHEMISTRY
  // section of the output.
  zpeEh?: number;
  enthalpyEh?: number;
  entropyCorrEh?: number;
  gibbsEh?: number;
  gMinusEEh?: number;

  // Spin contamination from the last <S**2> block (UHF/UKS only).
  s2?: number;
  s2Ideal?: number;

  /** Why the run failed or stalled (an ERROR_CLASS member — kept an open
   *  string so a newer wrapper can report a class this UI predates) plus a
   *  short excerpt of the output around the diagnosis. */
  errorClass?: string;
  errorExcerpt?: string;

  /** Lab-notebook layer: free-text note + tag chips, edited in the UI. */
  notes?: string;
  tags?: string[];

  /** Workflow lineage: the run this one was generated from and the
   *  follow-up kind (neb-ts | irc | endpoint-opt | sp | restart). */
  parentRunId?: string;
  parentEdgeKind?: string;

  submittedBy?: string;
  /** dftstream wrapper build that tracked this run (e.g. "v1.0.0"). */
  dftstreamVersion?: string;
}

export interface RunEvent {
  id: string;
  seq: number;
  ts: number;
  kind: string;
  payload: Record<string, unknown>;
}

export interface RunLog {
  id: string;
  ts: number;
  level: string;
  message: string;
  fields?: Record<string, unknown>;
}

export interface MetricPoint {
  ts: number;
  cycle?: number;
  iter?: number;
  value: number;
}

export interface Geometry {
  cycle: number;
  ts: number;
  xyz: string;
}

export interface Frequency {
  idx: number;
  wavenumber: number;
  imaginary: boolean;
  irIntensity?: number;
  /** 1-based hessian ordinal; absent on rows from pre-history wrappers. */
  hessIdx?: number;
}

export interface SysSample {
  ts: number;
  cpuPct: number;
  rssMb: number;
  threads: number;
}

// The artifact kinds the wrapper emits (db/convex/schema.ts stores kind as a
// plain string, so keep Artifact.kind tolerant of future values — but always
// compare against these constants, never inline literals).
export const ARTIFACT_KIND = {
  input: "input",
  stdout: "stdout",
  output: "output",
  property: "property",
  cube: "cube",
  vibmode: "vibmode",
  trj: "trj",
  goatMinimum: "goat_minimum",
  goatEnsemble: "goat_ensemble",
  other: "other",
} as const;
export type ArtifactKind = (typeof ARTIFACT_KIND)[keyof typeof ARTIFACT_KIND];

export interface Artifact {
  id: string;
  name: string;
  path: string;
  /** One of ARTIFACT_KIND (string-typed: the backend may add kinds). */
  kind: string;
  sizeBytes: number;
  mtime: number;
  truncated?: boolean;
  chunked?: boolean;
  hasContent: boolean;
}

export interface ArtifactContent {
  contentText: string;
  truncated: boolean;
  incomplete?: boolean;
}

// Progressive stream of an artifact body. `lines` grows as the file downloads;
// `fullText` is set once streaming completes (for consumers that need the whole
// body, e.g. parsers). Inline/legacy artifacts resolve in one shot.
export interface ArtifactTextStream {
  lines: string[];
  fullText?: string;
  loading: boolean;
  bytesLoaded: number;
  totalBytes?: number;
  truncated?: boolean;
  incomplete?: boolean;
  error?: boolean;
}

export type QueryResult<T> = { data: T | undefined; loading: boolean };

/**
 * A list query whose backend caps the number of rows it returns. `capped` is
 * true when the returned array is exactly the cap, i.e. rows beyond it exist
 * or may exist and were not sent. Every figure derived from `data` (a count, a
 * denominator, an energy reference) then describes the loaded slice only, and
 * the UI must say so rather than present it as the whole.
 */
export type CappedQueryResult<T> = QueryResult<T> & { capped: boolean };

export const POINT_ROLES = ["reactant", "ts", "intermediate", "product"] as const;
export type PointRole = (typeof POINT_ROLES)[number];

export interface PathwayPoint {
  runId: string;
  role: PointRole;
  order: number;
}

export interface Pathway {
  id: string;
  experimentId: string;
  name: string;
  createdAt: number;
  points: PathwayPoint[];
}

