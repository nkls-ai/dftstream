import { useMemo, useState } from "react";
import { useDataSource } from "../data/DataSource";
import type { Batch } from "../data/types";
import {
  computeBatchStats,
  failureExamplesByKey,
  groupFailures,
  matchesFilter,
  rankRuns,
  type StatusFilter,
} from "../lib/batchStats";
import {
  deriveBatchMetrics,
  groupByParam,
  pageEnergySpread,
  paramKeys,
} from "../lib/batchProgress";

// Runs pulled per page of the dense table. The headline numbers do not depend
// on this — they come from the rollup — so the page size is purely how much
// detail the chemist wants in front of them at once.
export const RUN_PAGE_SIZE = 200;

/**
 * Everything the batch dashboard renders, derived from the batch rollup and
 * the loaded page of runs. The component keeps only the JSX.
 */
export function useBatchDashboardModel(batch: Batch) {
  const ds = useDataSource();
  const progress = ds.useBatchProgress(batch.id);
  const runs = ds.useBatchRuns(batch.id, RUN_PAGE_SIZE);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [groupKey, setGroupKey] = useState<string>("");

  const loaded = useMemo(() => runs.data ?? [], [runs.data]);
  const rollup = progress.data ?? null;

  // Date.now() at render time is deliberate: the rollup is a live Convex
  // subscription, so every status change re-renders this and re-dates the
  // rate/ETA. A batch that is not moving has nothing to re-time.
  const metrics = useMemo(
    () => (rollup ? deriveBatchMetrics(rollup, Date.now()) : null),
    [rollup],
  );

  const ranked = useMemo(
    () => rankRuns(loaded, rollup?.minEnergyEh),
    [loaded, rollup?.minEnergyEh],
  );
  const filtered = useMemo(
    () => ranked.filter((r) => matchesFilter(r, filter)),
    [ranked, filter],
  );
  const spread = useMemo(() => pageEnergySpread(ranked), [ranked]);
  const outliers = useMemo(() => new Set(spread.outlierIds), [spread.outlierIds]);
  const keys = useMemo(() => paramKeys(ranked), [ranked]);
  const groups = useMemo(
    () => (groupKey ? groupByParam(ranked, groupKey) : []),
    [ranked, groupKey],
  );
  // "How many molecules" is answered by the batch parameters the wrapper was
  // given (--batch-params substrate=..., DFTSTREAM_BATCH_PARAMS), NOT by the
  // run name — a name is free text and two conformers of one substrate are two
  // names. Absent an explicit choice, the first parameter key is the sensible
  // default, since that is the one people put the molecule in.
  const moleculeKey = groupKey || keys[0];
  const moleculeGroups = useMemo(
    () => (moleculeKey ? groupByParam(ranked, moleculeKey) : undefined),
    [ranked, moleculeKey],
  );
  // Page-scoped fallbacks, used only while a batch has no rollup yet.
  const pageStats = useMemo(() => computeBatchStats(loaded), [loaded]);
  const pageFailures = useMemo(() => groupFailures(loaded), [loaded]);
  const failureExamples = useMemo(() => failureExamplesByKey(loaded), [loaded]);

  // The filter tiles read batch-wide when a rollup exists and page-scoped when
  // it does not. "In flight" is running + pending, matching what the "running"
  // filter selects.
  const tiles = metrics
    ? {
        total: metrics.total,
        inFlight: metrics.running + metrics.pending,
        finished: metrics.finished,
        failed: metrics.failed,
        suspicious: metrics.suspicious,
      }
    : {
        total: pageStats.total,
        inFlight: pageStats.running,
        finished: pageStats.finished,
        failed: pageStats.failed,
        suspicious: pageStats.suspicious,
      };

  return {
    progress,
    runs,
    filter,
    setFilter,
    groupKey,
    setGroupKey,
    loaded,
    rollup,
    metrics,
    ranked,
    filtered,
    spread,
    outliers,
    keys,
    groups,
    moleculeKey,
    moleculeGroups,
    pageStats,
    pageFailures,
    failureExamples,
    tiles,
  };
}

export type BatchDashboardModel = ReturnType<typeof useBatchDashboardModel>;
