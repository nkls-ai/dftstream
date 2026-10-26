import type { Run } from "../data/types";
import { formatTimeSetting, type TimeFormat } from "./settings";

export function formatDurationMs(ms: number, options: { compact?: boolean } = {}): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (options.compact) return `${hours}h ${remainingMinutes}m`;
  return `${hours}h ${remainingMinutes}m ${seconds}s`;
}

/**
 * Wallclock duration of a run in milliseconds, preferring ORCA's own
 * "TOTAL RUN TIME" (wallclockSec) over finishedAt−startedAt — for imported
 * runs startedAt is just the .out mtime. Null while the run is in flight.
 */
export function runWallMs(r: Pick<Run, "wallclockSec" | "startedAt" | "finishedAt">): number | null {
  if (r.wallclockSec != null) return r.wallclockSec * 1000;
  if (r.finishedAt != null) return r.finishedAt - r.startedAt;
  return null;
}

/** Compact duration cell for run tables: "3m 12s", "running…", or "-". */
export function runDurationLabel(
  r: Pick<Run, "wallclockSec" | "startedAt" | "finishedAt" | "status">,
): string {
  const ms = runWallMs(r);
  if (ms != null) return formatDurationMs(ms, { compact: true });
  if (r.status === "running") return "running…";
  return "-";
}

/** Relative "time ago" label for a past timestamp (ms epoch). */
export function formatTimeAgo(ts: number, now: number = Date.now()): string {
  const ms = now - ts;
  if (ms < 0) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return sec < 5 ? "just now" : `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ${min % 60}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/**
 * Absolute timestamp string for `title` tooltips on relative "time ago"
 * labels. Thin wrapper delegating to the settings formatter so tooltip and
 * settings-page rendering can never disagree (settings.ts does not import
 * this module, so the dependency is cycle-free).
 */
export function absoluteTimeTitle(ts: number, fmt: TimeFormat): string {
  return formatTimeSetting(ts, fmt);
}
