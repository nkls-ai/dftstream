// Pure derivation of every number on the batch dashboard. BatchModeView only
// renders what these functions return, so the arithmetic (which is where the
// lies hide) is unit-testable without React — see batchProgress.test.ts.
//
// Two sources feed the dashboard and they are NOT interchangeable:
//  - the `batchProgress` rollup: batch-wide, exact at any batch size, but it
//    only carries counters and sums (no per-run samples, so no median).
//  - the loaded page(s) of runs: full detail, but only for what is loaded.
// Anything derived from the page is named *page*  and must be labelled as such
// in the UI. Nothing here silently mixes the two.

import type { BatchProgress } from "../data/types";
import { EH_TO_KCAL } from "./constants";
import type { RankedRun } from "./batchStats";
import { errorClassLabel } from "./diagnosis";

/** Finished runs required before an ETA is shown at all. Below this the
 *  spread of two or three durations is noise, and a confident-looking
 *  "4h 12m" would be an invention. */
export const MIN_ETA_SAMPLES = 5;

/** Standard-normal quantile for p90. */
const Z_P90 = 1.2816;

const MS_PER_HOUR = 3_600_000;
const SEC_PER_HOUR = 3600;

/** Rate needs a window to be a rate: under a minute of elapsed time, a single
 *  completion reads as thousands per hour. */
const MIN_RATE_WINDOW_MS = 60_000;

// --- batch-wide metrics (from the rollup) ------------------------------------

/** Per-run duration distribution, reconstructed from Σt and Σt². Two moments
 *  cannot pin a distribution, so this is an explicit normal approximation:
 *  p50 is the mean and p90 is mean + 1.28σ. It is reported as a RANGE for
 *  exactly that reason — a single ETA number would be false precision. */
export interface DurationSpread {
  /** Runs the distribution is built from (finished runs). */
  sampleCount: number;
  meanSec: number;
  sdSec: number;
  p50Sec: number;
  p90Sec: number;
}

export interface BatchEta {
  p50Sec: number;
  p90Sec: number;
  /** Runs observed in flight right now. */
  observedConcurrency: number;
  /** Slots the ETA assumes — the observed concurrency, or 1 when nothing is
   *  running (the queue is drained or paused and the true rate is unknown). */
  assumedConcurrency: number;
}

export interface EnergyScale {
  count: number;
  minEh?: number;
  meanEh?: number;
  /** mean − min, in kcal/mol: how wide the batch's energy window is. */
  spreadKcal?: number;
}

export interface BatchMetrics {
  total: number;
  pending: number;
  running: number;
  finished: number;
  failed: number;
  /** finished + failed. */
  terminal: number;
  /** pending + running. */
  remaining: number;
  /** 0–100, share of runs that reached a terminal state. */
  percent: number;
  suspicious: number;

  completionsPerHour?: number;
  duration?: DurationSpread;
  eta?: BatchEta;

  coreHoursUsed: number;
  /** Straight-line projection to the whole batch at the observed cost per
   *  terminal run. Undefined until at least one run is terminal. */
  coreHoursProjected?: number;

  /** converged / (converged + notConverged) — runs that reported a flag. */
  convergedRate?: number;
  /** optMaxCycles / terminal. */
  optMaxCyclesRate?: number;
  /** withImaginary / finished. */
  imaginaryRate?: number;
  /** missingThermo / finished. */
  missingThermoRate?: number;

  energy: EnergyScale;
}

export function deriveBatchMetrics(p: BatchProgress, now: number): BatchMetrics {
  const terminal = p.finished + p.failed;
  const remaining = p.pending + p.running;
  const duration = durationSpread(p);
  const coreHoursUsed = p.coreSecondsSum / SEC_PER_HOUR;

  return {
    total: p.total,
    pending: p.pending,
    running: p.running,
    finished: p.finished,
    failed: p.failed,
    terminal,
    remaining,
    percent: p.total > 0 ? (terminal / p.total) * 100 : 0,
    suspicious: p.suspicious,
    completionsPerHour: completionsPerHour(p, terminal, now),
    duration,
    eta: eta(duration, remaining, p.running),
    coreHoursUsed,
    coreHoursProjected:
      terminal > 0 ? (coreHoursUsed / terminal) * p.total : undefined,
    convergedRate: ratio(p.converged, p.converged + p.notConverged),
    optMaxCyclesRate: ratio(p.optMaxCycles, terminal),
    imaginaryRate: ratio(p.withImaginary, p.finished),
    missingThermoRate: ratio(p.missingThermo, p.finished),
    energy: energyScale(p),
  };
}

function ratio(numerator: number, denominator: number): number | undefined {
  return denominator > 0 ? numerator / denominator : undefined;
}

function completionsPerHour(
  p: BatchProgress,
  terminal: number,
  now: number,
): number | undefined {
  if (p.firstStartedAt == null || terminal === 0) return undefined;
  const elapsedMs = now - p.firstStartedAt;
  if (elapsedMs < MIN_RATE_WINDOW_MS) return undefined;
  return terminal / (elapsedMs / MS_PER_HOUR);
}

function durationSpread(p: BatchProgress): DurationSpread | undefined {
  const n = p.finished;
  if (n <= 0) return undefined;
  const meanSec = p.wallclockSumSec / n;
  // Population variance from the two sums; clamped because floating-point
  // cancellation can push a genuinely zero variance slightly negative.
  const variance = Math.max(0, p.wallclockSumSqSec / n - meanSec * meanSec);
  const sdSec = Math.sqrt(variance);
  return {
    sampleCount: n,
    meanSec,
    sdSec,
    p50Sec: meanSec,
    p90Sec: meanSec + Z_P90 * sdSec,
  };
}

function eta(
  duration: DurationSpread | undefined,
  remaining: number,
  running: number,
): BatchEta | undefined {
  if (!duration || duration.sampleCount < MIN_ETA_SAMPLES) return undefined;
  if (remaining <= 0) return undefined;
  const assumedConcurrency = running > 0 ? running : 1;
  const waves = remaining / assumedConcurrency;
  return {
    p50Sec: waves * duration.p50Sec,
    p90Sec: waves * duration.p90Sec,
    observedConcurrency: running,
    assumedConcurrency,
  };
}

function energyScale(p: BatchProgress): EnergyScale {
  if (p.energyCount <= 0) return { count: 0, minEh: p.minEnergyEh };
  const meanEh = p.energySumEh / p.energyCount;
  return {
    count: p.energyCount,
    minEh: p.minEnergyEh,
    meanEh,
    spreadKcal:
      p.minEnergyEh == null ? undefined : (meanEh - p.minEnergyEh) * EH_TO_KCAL,
  };
}

// --- failure table ------------------------------------------------------------

/** Prefix the backend uses when a failure had no class and was bucketed by
 *  process exit code instead. Mirrors EXIT_CODE_KEY_PREFIX in
 *  db/convex/lib/batchSummary.ts. */
export const EXIT_CODE_KEY_PREFIX = "exit:";

export interface FailureRow {
  key: string;
  label: string;
  count: number;
  /** Share of failed runs, 0–1. */
  share: number;
  /** True when the bucket is an exit code, i.e. the classifier said nothing. */
  unclassified: boolean;
}

export function failureRows(
  failureCounts: Record<string, number>,
  failedTotal: number,
): FailureRow[] {
  return Object.entries(failureCounts)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => ({
      key,
      label: failureLabel(key),
      count,
      share: failedTotal > 0 ? count / failedTotal : 0,
      unclassified: key.startsWith(EXIT_CODE_KEY_PREFIX),
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function failureLabel(key: string): string {
  if (key.startsWith(EXIT_CODE_KEY_PREFIX)) {
    return `Exit code ${key.slice(EXIT_CODE_KEY_PREFIX.length)}`;
  }
  return errorClassLabel(key);
}

// --- page-scoped statistics ---------------------------------------------------
//
// A median and an outlier fence need the samples themselves, which the rollup
// deliberately does not keep. These therefore describe the LOADED runs only.

/** Tukey multiplier: beyond q3 + 1.5·IQR is the conventional "outlier". */
const IQR_FENCE = 1.5;

export interface PageEnergySpread {
  /** Loaded runs that have a relative energy. */
  count: number;
  medianKcal?: number;
  q1Kcal?: number;
  q3Kcal?: number;
  upperFenceKcal?: number;
  /** Ids of loaded runs sitting above the fence. */
  outlierIds: string[];
}

export function pageEnergySpread(rows: RankedRun[]): PageEnergySpread {
  const withEnergy = rows.filter(
    (r): r is RankedRun & { relativeKcal: number } =>
      r.relativeKcal != null && Number.isFinite(r.relativeKcal),
  );
  if (withEnergy.length === 0) return { count: 0, outlierIds: [] };
  const sorted = withEnergy.map((r) => r.relativeKcal).sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const upperFence = q3 + IQR_FENCE * (q3 - q1);
  return {
    count: sorted.length,
    medianKcal: quantile(sorted, 0.5),
    q1Kcal: q1,
    q3Kcal: q3,
    upperFenceKcal: upperFence,
    // A batch of identical energies has a zero IQR; flagging everything equal
    // to the fence as an outlier would be absurd, so the test is strict.
    outlierIds: withEnergy.filter((r) => r.relativeKcal > upperFence).map((r) => r.id),
  };
}

/** Linear-interpolation quantile over an ascending array. */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const loValue = sorted[lo] ?? NaN;
  if (lo === hi) return loValue;
  const hiValue = sorted[hi] ?? loValue;
  return loValue + (hiValue - loValue) * (pos - lo);
}

export interface ParamGroup {
  value: string;
  count: number;
  finished: number;
  failed: number;
  medianKcal?: number;
  bestKcal?: number;
}

/** paramKeys is the union of batchParams keys across the loaded runs — the
 *  choices offered by the group-by control. */
export function paramKeys(rows: RankedRun[]): string[] {
  const keys = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r.batchParams ?? {})) keys.add(k);
  }
  return [...keys].sort();
}

/** Placeholder bucket for loaded runs that did not carry the grouped key. */
export const UNSET_PARAM_VALUE = "(unset)";

export function groupByParam(rows: RankedRun[], key: string): ParamGroup[] {
  const buckets = new Map<string, RankedRun[]>();
  for (const r of rows) {
    const raw = r.batchParams?.[key];
    const value = raw === undefined ? UNSET_PARAM_VALUE : String(raw);
    const bucket = buckets.get(value);
    if (bucket) bucket.push(r);
    else buckets.set(value, [r]);
  }
  return [...buckets.entries()]
    .map(([value, group]) => {
      const energies = group
        .map((r) => r.relativeKcal)
        .filter((e): e is number => e != null && Number.isFinite(e))
        .sort((a, b) => a - b);
      return {
        value,
        count: group.length,
        finished: group.filter((r) => r.status === "finished").length,
        failed: group.filter((r) => r.status === "failed").length,
        medianKcal: energies.length > 0 ? quantile(energies, 0.5) : undefined,
        bestKcal: energies[0],
      };
    })
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}
