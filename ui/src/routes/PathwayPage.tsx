import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useDataSource } from "../data/DataSource";
import type { Run } from "../data/types";
import { routes } from "../lib/routes";
import { RowMenu } from "../components/RowMenu";
import { useConfirm, usePrompt } from "../components/Confirm";
import { SkeletonPanel } from "../components/Skeleton";
import { PathwayBuilder } from "./PathwayBuilder";
import { PathwayViewer } from "./PathwayViewer";
import { useGuardedAction } from "../hooks/useGuardedAction";
import { NotFoundState } from "../components/NotFoundState";
import { EntityKind } from "../lib/notFoundOrNoAccess";

export function PathwayPage() {
  const { expId = "", pathwayId = "" } = useParams();
  const nav = useNavigate();
  const ds = useDataSource();
  const prompt = usePrompt();
  const confirm = useConfirm();
  const guard = useGuardedAction();

  const exp = ds.useExperiment(expId);
  const pathway = ds.usePathway(pathwayId);
  const runs = ds.useRunsByExperiment(expId);

  const [editing, setEditing] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  // Auto-enter builder when pathway has no points (just created)
  const autoEdited = useRef(false);
  useEffect(() => {
    if (pathway.data && pathway.data.points.length === 0 && !autoEdited.current) {
      autoEdited.current = true;
      setEditing(true);
    }
  }, [pathway.data]);

  const runsById = useMemo(() => {
    const map = new Map<string, Run>();
    for (const r of runs.data ?? []) map.set(r.id, r);
    return map;
  }, [runs.data]);

  const onRename = async () => {
    if (!pathway.data) return;
    const next = await prompt({
      title: "Rename pathway",
      defaultValue: pathway.data.name,
      placeholder: "Pathway name",
      validate: (v) => (v.trim().length === 0 ? "Name cannot be empty." : null),
    });
    if (next == null) return;
    await guard("rename pathway", () => ds.renamePathway(pathwayId, next.trim()));
  };

  const onDelete = async () => {
    const ok = await confirm({
      title: `Delete pathway "${pathway.data?.name}"?`,
      tone: "danger",
      confirmLabel: "Delete",
      message: "This cannot be undone.",
    });
    if (!ok) return;
    await guard("delete pathway", async () => {
      await ds.removePathway(pathwayId);
      nav(routes.experiment(expId));
    });
  };

  if (pathway.loading || runs.loading) {
    return (
      <>
        <div className="breadcrumbs">
          <Link to={routes.experiments}>Experiments</Link> ›{" "}
          <Link to={routes.experiment(expId)}>{exp.data?.name ?? "…"}</Link> › …
        </div>
        <SkeletonPanel rows={6} />
      </>
    );
  }

  if (!pathway.data) {
    return <NotFoundState entity={EntityKind.PATHWAY} />;
  }

  const pw = pathway.data;

  return (
    <>
      <div className="breadcrumbs">
        <Link to={routes.experiments}>Experiments</Link> ›{" "}
        <Link to={routes.experiment(expId)}>{exp.data?.name ?? "…"}</Link> ›{" "}
        <span className="mono">{pw.name}</span>
      </div>
      <div className="page-header">
        <div>
          <h1>{pw.name}</h1>
          <div className="subtitle">
            Reaction pathway · {pw.points.length} stationary point{pw.points.length !== 1 ? "s" : ""}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button type="button"
            className="button"
            onClick={() => setEditing(!editing)}
          >
            {editing ? "Cancel" : "Edit pathway"}
          </button>
          <RowMenu
            ariaLabel="pathway actions"
            items={[
              { label: "Rename…", onClick: onRename },
              { label: "Delete…", tone: "danger", onClick: onDelete },
            ]}
          />
        </div>
      </div>

      {editing ? (
        <PathwayBuilder
          pathway={pw}
          runs={runs.data ?? []}
          onSave={async (points) => {
            await ds.updatePathwayPoints(pathwayId, points);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <PathwayViewer
          pathway={pw}
          runsById={runsById}
          expId={expId}
          selectedRunId={selectedRunId}
          onSelectRun={setSelectedRunId}
        />
      )}
    </>
  );
}
