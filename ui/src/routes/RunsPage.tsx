import { useState } from "react";
import { routes } from "../lib/routes";
import { Link, useParams } from "react-router-dom";
import { useDataSource } from "../data/DataSource";
import { SkeletonTable } from "../components/Skeleton";
import { BenchmarkView } from "./BenchmarkView";
import { BatchModeView } from "./BatchModeView";
import { EnergyView } from "./EnergyView";
import { RunsTable } from "./RunsTable";
import { ExperimentQueueSection } from "./ExperimentQueueSection";
import { PathwaySection } from "./PathwaySection";
import { WorkflowSection } from "./WorkflowSection";
import { RunsPageActions } from "./RunsPageActions";
import { useOptimisticOverlay } from "../hooks/useOptimisticOverlay";
import { TRUNCATION_TITLE, runCountLabel } from "../lib/truncation";
import { NotFoundState } from "../components/NotFoundState";
import { EntityKind } from "../lib/notFoundOrNoAccess";

type ExpTab = "runs" | "energies" | "benchmark" | "batch";

const EXP_TABS: { id: ExpTab; label: string }[] = [
  { id: "runs", label: "Runs" },
  { id: "energies", label: "Energies" },
  { id: "benchmark", label: "Benchmark" },
  { id: "batch", label: "Batch Mode" },
];

export function RunsPage() {
  const { expId = "" } = useParams();
  const ds = useDataSource();
  const exp = ds.useExperiment(expId);
  const runs = ds.useRunsByExperiment(expId);
  const batches = ds.useBatchesByExperiment(expId);
  const pathways = ds.usePathwaysByExperiment(expId);
  const [tab, setTab] = useState<ExpTab>("runs");
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);

  const overlay = useOptimisticOverlay(runs.data);
  const visible = overlay.visible;

  if (!exp.loading && !exp.data) {
    return <NotFoundState entity={EntityKind.EXPERIMENT} />;
  }

  return (
    <>
      <div className="breadcrumbs">
        <Link to={routes.experiments}>Experiments</Link> ›{" "}
        <span className="mono">{exp.data?.name ?? "…"}</span>
      </div>
      <div className="page-header">
        <div>
          <h1>{exp.data?.name ?? "Experiment"}</h1>
          <div className="subtitle">
            {runs.data ? runCountLabel(runs.data.length, runs.capped) : " "}
          </div>
          {runs.capped && (
            <div className="subtitle muted" title={TRUNCATION_TITLE}>
              Showing the {runs.data?.length} most recent runs — older runs are
              not loaded, so every figure on this page describes that slice.
            </div>
          )}
        </div>
        <RunsPageActions
          expId={expId}
          onBatchCreated={(id) => {
            setSelectedBatchId(id);
            setTab("batch");
          }}
        />
      </div>

      <div className="exp-tab-bar">
        {EXP_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={"exp-tab-btn" + (tab === t.id ? " active" : "")}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "energies" ? (
        <EnergyView expId={expId} runs={visible} capped={runs.capped} />
      ) : tab === "benchmark" ? (
        <BenchmarkView runs={visible} expId={expId} capped={runs.capped} />
      ) : tab === "batch" ? (
        <BatchModeView
          expId={expId}
          batches={batches.data ?? []}
          // Deliberately no `runs` prop: the dashboard subscribes to the batch
          // rollup and its own paginated run list. Feeding it this capped,
          // experiment-scoped array is what made a 2400-run batch report the
          // numbers of 1000 runs, and filtering it here every render bought
          // nothing but that risk.
          selectedBatchId={selectedBatchId ?? batches.data?.[0]?.id ?? null}
          onSelectBatch={setSelectedBatchId}
        />
      ) : runs.loading ? (
        <SkeletonTable rows={8} cols={7} />
      ) : (
        <>
          {/* Jobs handed to the scheduler that have no tracked run yet —
              visible even while the experiment has zero runs. */}
          <ExperimentQueueSection
            expId={expId}
            loadedRunIds={new Set(visible.map((r) => r.id))}
          />
          {!visible.length ? (
            <div className="empty-state">No runs in this experiment yet.</div>
          ) : (
            <RunsTable expId={expId} runs={visible} overlay={overlay} capped={runs.capped} />
          )}
        </>
      )}

      <WorkflowSection expId={expId} experimentName={exp.data?.name ?? ""} runs={visible} />

      <PathwaySection expId={expId} pathways={pathways.data ?? []} />
    </>
  );
}
