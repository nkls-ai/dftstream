import { Link } from "react-router-dom";
import { routes } from "../lib/routes";
import type { Run } from "../data/types";
import { RunStatusBadge } from "../components/RunStatusBadge";
import { CopyIcon } from "./runDetailUi";
import { methodHeadline, solventLabel } from "./runHeadline";
import { RunTagsEditor } from "./RunAnnotations";
import { compareBasketToggle, useCompareBasket } from "../lib/compareBasket";

/** Breadcrumbs + title/status/method header for the run detail page. */
export function RunDetailHeader({
  expId,
  runId,
  expName,
  run,
}: {
  expId: string;
  runId: string;
  expName: string | undefined;
  run: Run | undefined;
}) {
  const solvent = solventLabel(run);
  const basket = useCompareBasket();
  const inBasket = basket.includes(runId);
  const copyRunId = () => {
    navigator.clipboard.writeText(runId).catch(() => { /* clipboard not available in insecure context */ });
  };

  return (
    <>
      <div className="breadcrumbs">
        <Link to={routes.experiments}>Experiments</Link> ›{" "}
        <Link to={routes.experiment(expId)}>
          {expName ?? "…"}
        </Link>{" "}
        › <span className="mono">{run?.name ?? runId.slice(0, 10)}</span>
      </div>
      <header className="detail-header">
        <div className="detail-header-top">
          <div>
            <h1 className="detail-header-title">
              {run?.name ?? "Run"}
            </h1>
            <div className="detail-header-meta">
              {run && <RunStatusBadge status={run.status} />}
              {run && (
                <span className="tag-pill" data-tooltip="Method · basis · job type">
                  {methodHeadline(run)}
                </span>
              )}
              {solvent && (
                <span className="tag-pill">{solvent}</span>
              )}
              <span
                className="detail-header-runid"
                data-tooltip="Copy run ID"
                onClick={copyRunId}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); copyRunId(); } }}
                role="button"
                tabIndex={0}
                aria-label="Copy run ID"
              >
                {runId.slice(0, 12)}…
                <CopyIcon />
              </span>
              <button
                type="button"
                className={"tag-pill run-tag-add" + (inBasket ? " compare-header-active" : "")}
                title={inBasket ? "Remove from comparison" : "Add to cross-experiment comparison"}
                onClick={() => compareBasketToggle(runId)}
              >
                ⇄ {inBasket ? "in compare" : "compare"}
              </button>
              {run && <RunTagsEditor run={run} />}
            </div>
          </div>
        </div>
      </header>
    </>
  );
}
