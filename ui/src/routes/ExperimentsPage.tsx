import { useState } from "react";
import { useDataSource } from "../data/DataSource";
import { SkeletonCards } from "../components/Skeleton";
import type { ExperimentSummary } from "../data/types";
import { useSettings } from "../lib/settings";
import { orgQueryArg, useOrg } from "../auth/OrgContext";
import { useOptimisticOverlay } from "../hooks/useOptimisticOverlay";
import { ExperimentCard } from "./ExperimentCard";
import {
  EXPERIMENT_SORT_OPTIONS,
  filterExperiments,
  sortExperiments,
  type ExperimentSortMode,
} from "./experimentsList";

function totalRuns(xs: ExperimentSummary[]): number {
  return xs.reduce((n, e) => n + e.runCount, 0);
}

export function ExperimentsPage() {
  const ds = useDataSource();
  const [settings] = useSettings();
  const org = useOrg();
  const { data, loading, canLoadMore, loadingMore, loadMore } =
    ds.useExperimentsWithSummary(settings.experimentPageSize, orgQueryArg(org));

  const overlay = useOptimisticOverlay(data);
  const visible = overlay.visible;

  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<ExperimentSortMode>("newest");
  // Filter/sort apply to the loaded pages only; Load more keeps fetching
  // regardless so a search can be widened by loading further pages.
  const shown = sortExperiments(filterExperiments(visible, query), sortMode);
  const isFiltered = query.trim() !== "";

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Experiments</h1>
          <div className="subtitle">
            {data
              ? `${visible.length} loaded experiment${visible.length === 1 ? "" : "s"} · ${totalRuns(visible)} loaded run${totalRuns(visible) === 1 ? "" : "s"}`
              : " "}
          </div>
        </div>
      </div>
      {org.authEnabled && !org.activeOrgId ? (
        <div className="empty-state">
          {org.orgs.length === 0
            ? "You're not in any organization yet. Create one from the sidebar to get started."
            : "Select an organization from the sidebar."}
        </div>
      ) : loading ? (
        <SkeletonCards count={6} />
      ) : visible.length === 0 ? (
        <div className="empty-state">
          No experiments yet. Run <code>dftstream run …</code> to record one.
        </div>
      ) : (
        <>
          <div className="table-toolbar">
            <input
              type="search"
              placeholder="Filter experiments…"
              aria-label="Filter experiments"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              className="settings-select"
              aria-label="Sort experiments"
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as ExperimentSortMode)}
            >
              {EXPERIMENT_SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {isFiltered && (
              <span className="table-toolbar-count">
                {shown.length} of {visible.length} experiments
              </span>
            )}
          </div>
          {shown.length === 0 ? (
            <div className="empty-state">No loaded experiments match “{query.trim()}”.</div>
          ) : (
            <div className="exp-grid">
              {shown.map((e) => (
                <ExperimentCard
                  key={e.id}
                  exp={e}
                  onMarkRemoving={overlay.markRemoving}
                  onUnmarkRemoving={overlay.unmarkRemoving}
                  onOptimisticRename={overlay.setRename}
                  onClearOptimisticRename={overlay.clearRename}
                />
              ))}
            </div>
          )}
          {canLoadMore && (
            <div className="load-more-row">
              <button
                type="button"
                className="button"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading..." : `Load ${settings.experimentPageSize} more`}
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}
