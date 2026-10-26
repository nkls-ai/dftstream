import { useState } from "react";
import { Link } from "react-router-dom";
import { useDataSource } from "../data/DataSource";
import type { Run } from "../data/types";
import { routes } from "../lib/routes";
import { ChainFollowups } from "./NextStepsPanel";
import { userErrorMessage } from "../lib/errorReporting";

/** Human labels for the lineage edge kinds the wrapper records. */
const EDGE_LABELS: Record<string, string> = {
  "neb-ts": "NEB-TS from",
  irc: "IRC of",
  "endpoint-opt": "endpoint opt of",
  sp: "single point on",
  restart: "restart of",
};

function edgeLabel(kind: string | undefined): string {
  return (kind && EDGE_LABELS[kind]) || "generated from";
}

/**
 * Workflow lineage strip: where this run came from (restart / `dftstream
 * next` provenance, or a manually set parent) and which runs were generated
 * from it. Renders nothing for runs with no lineage and no siblings to pick.
 */
export function RunLineageSection({ run }: { run: Run }) {
  const ds = useDataSource();
  const parent = ds.useRun(run.parentRunId ?? "skip");
  const children = ds.useRunChildren(run.id);
  const [editing, setEditing] = useState(false);
  const [chaining, setChaining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const siblings = ds.useRunsByExperiment(editing || chaining ? run.experimentId : "skip");
  // The run page already subscribes to the experiment, so this is cached.
  const exp = ds.useExperiment(run.experimentId);

  const setParent = (parentRunId: string | null) => {
    setError(null);
    ds.setRunParent(run.id, parentRunId).then(
      () => setEditing(false),
      (e: unknown) => setError(userErrorMessage(e, "set the parent run")),
    );
  };

  const kids = children.data ?? [];
  const chainToggle = (
    <button
      className="tag-pill run-tag-add"
      onClick={() => setChaining((c) => !c)}
      title="Generate a follow-up input from this run"
    >
      {chaining ? "close" : "chain ▸"}
    </button>
  );
  const chainPanel = chaining && (
    <div className="lineage-chain">
      {siblings.loading ? (
        <span className="muted" style={{ fontSize: 12 }}>loading runs…</span>
      ) : (
        <ChainFollowups run={run} partners={siblings.data ?? []} experimentName={exp.data?.name ?? ""} />
      )}
    </div>
  );

  const hasLineage = run.parentRunId != null || kids.length > 0;
  if (!hasLineage && !editing) {
    return (
      <div className="lineage-strip lineage-empty">
        <button className="tag-pill run-tag-add" onClick={() => setEditing(true)} title="Link this run to the run it was derived from">
          + link parent run
        </button>
        {chainToggle}
        {chainPanel}
      </div>
    );
  }

  return (
    <div className="lineage-strip">
      {run.parentRunId != null && (
        <span className="lineage-parent">
          ↰ {edgeLabel(run.parentEdgeKind)}{" "}
          {parent.data ? (
            <Link to={routes.run(parent.data.experimentId, parent.data.id)}>
              {parent.data.name ?? "unnamed run"}
            </Link>
          ) : (
            <span className="mono">{parent.loading ? "…" : "(deleted run)"}</span>
          )}
        </span>
      )}
      {kids.length > 0 && (
        <span className="lineage-children">
          ↳{" "}
          {kids.map((c, i) => (
            <span key={c.id}>
              {i > 0 && ", "}
              <Link to={routes.run(c.experimentId, c.id)}>{c.name ?? "unnamed run"}</Link>
              {c.parentEdgeKind ? <span className="lineage-edge"> ({c.parentEdgeKind})</span> : null}
            </span>
          ))}
        </span>
      )}
      {!editing ? (
        <button className="tag-pill run-tag-add" onClick={() => setEditing(true)}>
          {run.parentRunId != null ? "edit" : "+ link parent run"}
        </button>
      ) : (
        <span className="lineage-edit">
          <select
            defaultValue={run.parentRunId ?? ""}
            onChange={(e) => setParent(e.target.value === "" ? null : e.target.value)}
          >
            <option value="">(no parent)</option>
            {(siblings.data ?? [])
              .filter((s) => s.id !== run.id)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name ?? s.id}
                </option>
              ))}
          </select>
          <button className="tag-pill run-tag-add" onClick={() => { setEditing(false); setError(null); }}>
            cancel
          </button>
        </span>
      )}
      {chainToggle}
      {error && <span className="lineage-error">could not save: {error}</span>}
      {chainPanel}
    </div>
  );
}
