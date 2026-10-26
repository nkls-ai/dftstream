// Shared y-axis chrome for the recharts line charts (EnergyChart, TimeChart,
// pathway profile, MECP, spectra). One place decides how the rotated axis
// title is placed and how many decimals the ticks carry, so no chart can
// draw its title across its tick labels or print five identical ticks.

/** Ticks per axis; recharts' default, which our charts never override. */
const DEFAULT_TICKS = 5;
/** Upper bound: beyond this a span is numerical noise, not a trend. */
const MAX_DECIMALS = 10;
/** Used when the span is zero (a single point, or a perfectly flat line). */
const FLAT_DECIMALS = 4;

/**
 * Decimals needed for `tickCount` evenly spaced ticks across a data span of
 * `span` to print as distinct numbers. The tick step is about
 * span / (tickCount - 1); one decimal per order of magnitude below 1.
 */
export function tickDecimalsForSpan(span: number, tickCount = DEFAULT_TICKS): number {
  if (!Number.isFinite(span) || span <= 0) return FLAT_DECIMALS;
  const step = span / Math.max(1, tickCount - 1);
  const decimals = Math.ceil(-Math.log10(step));
  return Math.min(MAX_DECIMALS, Math.max(0, decimals));
}

/** Min/max of the finite values; null when there are none. */
function finiteRange(values: readonly number[]): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo <= hi ? [lo, hi] : null;
}

/** Min/max span of the finite values; 0 when fewer than two are finite. */
export function valueSpan(values: readonly number[]): number {
  const r = finiteRange(values);
  return r ? r[1] - r[0] : 0;
}

export interface NiceAxis {
  domain: [number, number];
  ticks: number[];
  /** Formats every tick with the same, step-derived precision. */
  format: (v: number) => string;
}

/**
 * Evenly spaced ticks on a 1 / 2 / 2.5 / 5 × 10ⁿ step covering `values`,
 * with one shared precision. recharts' own "nice" steps (e.g. 6.5e-7) give
 * ragged labels such as -422.8851120 / -422.88511265, and a fixed
 * toFixed(4) prints five identical ticks for a converged SCF cycle.
 * Returns null for flat or empty data; callers then let recharts pick.
 */
export function niceAxis(values: readonly number[], tickCount = DEFAULT_TICKS): NiceAxis | null {
  const range = finiteRange(values);
  if (!range || range[1] <= range[0]) return null;
  const [min, max] = range;
  const raw = (max - min) / Math.max(1, tickCount - 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const niceNorm = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  const step = niceNorm * mag;
  const decimals = Math.min(
    MAX_DECIMALS + 1,
    Math.max(0, -Math.floor(Math.log10(step) + 1e-9) + (niceNorm === 2.5 ? 1 : 0)),
  );
  const first = Math.floor(min / step + 1e-9);
  const last = Math.ceil(max / step - 1e-9);
  const ticks: number[] = [];
  for (let i = first; i <= last; i++) ticks.push(Number((i * step).toFixed(decimals)));
  return {
    domain: [ticks[0]!, ticks[ticks.length - 1]!],
    ticks,
    format: (v) => (Number.isFinite(v) ? v.toFixed(decimals) : ""),
  };
}

/** Tick formatter for a flat series recharts pads itself. */
export function flatTickFormatter(v: number): string {
  return Number.isFinite(v) ? v.toFixed(FLAT_DECIMALS) : "";
}

/**
 * YAxis `width="auto"`: recharts measures the rendered tick labels plus the
 * rotated title and reserves exactly that much, so the title sits left of
 * the widest tick instead of on top of it (a fixed 60 px did not fit
 * "-422.8851").
 */
export const Y_AXIS_WIDTH = "auto" as const;

/** Rotated y-axis title, placed at the outer edge of the auto-sized axis. */
export function yAxisTitle(value: string, fill: string) {
  return {
    value,
    angle: -90,
    position: "insideLeft" as const,
    fill,
    style: { textAnchor: "middle" as const },
  };
}
