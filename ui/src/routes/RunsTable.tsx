import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { routes } from "../lib/routes";
import { RunStatusBadge } from "../components/RunStatusBadge";
import { RunChips } from "../components/KeywordChips";
import type { Run } from "../data/types";
import { runDurationLabel, runWallMs } from "../lib/time";
import { runsTableConvergence } from "../lib/convergence";
import type { SortAccessors } from "../lib/tableSort";
import { useTableSort } from "../hooks/useTableSort";
import { SortableTh } from "../components/SortableTh";
import { RunRowMenu } from "./RunRowMenu";
import { filterRuns } from "./runsTableFilter";
import { runKeywordLine } from "./runKeywordLine";
import { renderOrcaLine } from "../syntax/orca/orcaRender";
import { compareBasketToggle, useCompareBasket } from "../lib/compareBasket";
import type { OptimisticOverlay } from "../hooks/useOptimisticOverlay";
import { TRUNCATION_TITLE, filteredCountLabel } from "../lib/truncation";
import { useEhFormatter } from "../lib/useEnergyFormat";

/** One-cell rendering of the raw `!` line, syntax-colored like the input
 *  echo. Legacy runs without keywords/inputText fall back to the chips.
 *  Lines wider than the cell get an ellipsis; hovering them opens a
 *  popover with the full highlighted line. */
function KeywordLineCell({ run: r }: { run: Run }) {
  const line = runKeywordLine(r);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const [pop, setPop] = useState<{ left: number; top: number; maxWidth: number } | null>(null);

  const showIfTruncated = () => {
    const el = textRef.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    const rect = el.getBoundingClientRect();
    // position: fixed so the popover escapes the sticky-head scroll clipping
    setPop({
      left: rect.left,
      top: rect.bottom + 4,
      maxWidth: Math.max(240, Math.min(640, window.innerWidth - rect.left - 16)),
    });
  };

  if (!line) {
    return (
      <td className="mono kw-cell">
        <RunChips run={r} compact />
      </td>
    );
  }
  return (
    <td className="mono kw-cell" onMouseEnter={showIfTruncated} onMouseLeave={() => setPop(null)}>
      <span ref={textRef} className="kw-line">
        {renderOrcaLine(line, "input")}
      </span>
      {pop && (
        <div className="kw-pop" style={pop}>
          {renderOrcaLine(line, "input")}
        </div>
      )}
    </td>
  );
}

function ConvergenceBadge({ run: r }: { run: Run }) {
  const badge = runsTableConvergence(r);
  if (!badge) return null;
  return (
    <span className={`conv-badge conv-${badge.tone}`} title={badge.title}>
      {badge.label}
    </span>
  );
}

// Column key -> sort value. Natural order (sort cleared) is the server's
// newest-first ordering.
const RUNS_ACCESSORS: SortAccessors<Run> = {
  name: (r) => r.name ?? r.id,
  status: (r) => r.status,
  keywords: (r) => runKeywordLine(r) ?? undefined,
  convergence: (r) => runsTableConvergence(r)?.label,
  duration: (r) => runWallMs(r),
  lastEnergy: (r) => r.lastEnergy,
  submittedBy: (r) => r.submittedBy,
};

/** The main runs table on an experiment page. */
export function RunsTable({
  expId,
  runs,
  overlay,
  capped = false,
}: {
  expId: string;
  runs: Run[];
  overlay: OptimisticOverlay<Run>;
  /** `runs` is the backend-capped slice, not the whole experiment: the filter
   *  searches only what is loaded, so "0 of 1000" can mean "not on this page"
   *  rather than "does not exist". Say so instead of implying a total. */
  capped?: boolean;
}) {
  const [query, setQuery] = useState("");
  const basket = useCompareBasket();
  const fmtEh = useEhFormatter();
  const table = useTableSort("runs");
  const filtered = filterRuns(runs, query);
  const sorted = table.sorted(filtered, RUNS_ACCESSORS);
  const isFiltered = query.trim() !== "";

  return (
    <>
      <div className="table-toolbar">
        <input
          type="search"
          placeholder="Filter runs…"
          aria-label="Filter runs"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {isFiltered && (
          <span className="table-toolbar-count" title={capped ? TRUNCATION_TITLE : undefined}>
            {filteredCountLabel(filtered.length, runs.length, capped)}
          </span>
        )}
      </div>
      <div className="sticky-head" style={{ maxHeight: "70vh" }}>
        <table className="table">
          <thead>
            <tr>
              <SortableTh label="Name" sortKey="name" table={table} />
              <SortableTh label="Status" sortKey="status" table={table} />
              <SortableTh label="Keywords" sortKey="keywords" table={table} />
              <SortableTh label="Convergence" sortKey="convergence" table={table} />
              <SortableTh label="Duration" sortKey="duration" table={table} defaultDir="desc" />
              <SortableTh label="Last energy (Eh)" sortKey="lastEnergy" table={table} />
              <SortableTh label="Submitted by" sortKey="submittedBy" table={table} />
              <th aria-label="Actions" style={{ width: 36 }}></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id}>
                <td className="nowrap-cell">
                  <Link to={routes.run(expId, r.id)}>
                    {r.name ?? r.id.slice(0, 10)}
                  </Link>
                  {r.tags && r.tags.length > 0 && (
                    <span className="run-tags" style={{ marginLeft: 8 }}>
                      {r.tags.map((t) => (
                        <span key={t} className="tag-pill run-tag">{t}</span>
                      ))}
                    </span>
                  )}
                  <button
                    type="button"
                    className={"compare-toggle" + (basket.includes(r.id) ? " active" : "")}
                    title={basket.includes(r.id) ? "Remove from comparison" : "Add to comparison (cross-experiment)"}
                    aria-label={basket.includes(r.id) ? `Remove ${r.name ?? r.id} from comparison` : `Add ${r.name ?? r.id} to comparison`}
                    onClick={() => compareBasketToggle(r.id)}
                  >
                    ⇄
                  </button>
                </td>
                <td className="nowrap-cell">
                  <RunStatusBadge status={r.status} />
                  {r.status === "failed" && r.exitCode != null && (
                    <span className="mono muted" style={{ fontSize: 12, marginLeft: 4 }}>exit {r.exitCode}</span>
                  )}
                </td>
                <KeywordLineCell run={r} />
                <td>
                  <ConvergenceBadge run={r} />
                </td>
                <td className="mono muted">{runDurationLabel(r)}</td>
                <td className="mono">
                  {fmtEh(r.lastEnergy)}
                </td>
                <td className="mono muted">{r.submittedBy ?? "-"}</td>
                <td>
                  <RunRowMenu
                    runId={r.id}
                    runName={r.name ?? r.id.slice(0, 10)}
                    onMarkRemoving={overlay.markRemoving}
                    onUnmarkRemoving={overlay.unmarkRemoving}
                    onOptimisticRename={overlay.setRename}
                    onClearOptimisticRename={overlay.clearRename}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
