import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { usePrompt } from "../components/Confirm";
import { useDataSource } from "../data/DataSource";
import type { PathwayPoint, PointRole, Run } from "../data/types";
import { isTSSearchRun, runsTableConvergence } from "../lib/convergence";
import { routes } from "../lib/routes";
import { buildWorkflowForest, flattenForest, type WorkflowNode } from "../lib/workflowTree";
import { ChainFollowups } from "./NextStepsPanel";
import { useEhFormatter } from "../lib/useEnergyFormat";
import { useGuardedAction } from "../hooks/useGuardedAction";

/** Human labels for the lineage edge kinds the wrapper records. */
const EDGE_LABELS: Record<string, string> = {
  "neb-ts": "neb-ts",
  irc: "irc",
  "endpoint-opt": "endpoint opt",
  sp: "sp",
  restart: "restart",
};

/** One run in a chain: identity, verdict and energies, plus chain tools. */
function WorkflowNodeRow({
  node,
  depth,
  expId,
  experimentName,
  partners,
  selected,
  onToggle,
}: {
  node: WorkflowNode;
  depth: number;
  expId: string;
  experimentName: string;
  partners: Run[];
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  const [chaining, setChaining] = useState(false);
  const r = node.run;
  const badge = runsTableConvergence(r);
  const edge = r.parentEdgeKind ? (EDGE_LABELS[r.parentEdgeKind] ?? r.parentEdgeKind) : null;
  const fmtEh = useEhFormatter();
  const e = r.lastEnergy != null ? fmtEh(r.lastEnergy) : null;
  const g = r.gibbsEh != null ? fmtEh(r.gibbsEh) : null;
  return (
    <>
      <li className="wf-node" style={{ paddingLeft: depth * 26 }}>
        <label className="wf-check" title="select for a reaction profile">
          <input type="checkbox" checked={selected.has(r.id)} onChange={() => onToggle(r.id)} />
        </label>
        {depth > 0 && <span className="wf-elbow" aria-hidden>↳</span>}
        {edge && <span className="wf-edge">{edge}</span>}
        <Link className="wf-name" to={routes.run(expId, r.id)}>
          {r.name ?? "unnamed run"}
        </Link>
        {r.jobType && <span className="wf-type mono">{r.jobType}</span>}
        {badge && (
          <span className={`conv-badge conv-${badge.tone}`} title={badge.title}>
            {badge.label}
          </span>
        )}
        <span className="wf-numbers mono">
          {e && <span title="final electronic energy">E {e} Eh</span>}
          {g && <span title="Gibbs free energy">G {g} Eh</span>}
          {r.imaginaryModes != null && (
            <span className={r.imaginaryModes === 1 ? "wf-imag-one" : undefined} title="imaginary modes">
              {r.imaginaryModes} imag
            </span>
          )}
        </span>
        <button className="tag-pill run-tag-add" onClick={() => setChaining((c) => !c)}>
          {chaining ? "close" : "chain ▸"}
        </button>
      </li>
      {chaining && (
        <li className="wf-chain-panel" style={{ paddingLeft: depth * 26 + 30 }}>
          <ChainFollowups run={r} partners={partners} experimentName={experimentName} />
        </li>
      )}
    </>
  );
}

/**
 * Guessed roles for a profile built from a selection: TS searches are TS
 * points, the first/last remaining runs are reactant/product. Only a
 * default — the pathway builder edits every role afterwards.
 */
export function selectionToPoints(runs: Run[]): PathwayPoint[] {
  const nonTs = runs.filter((r) => !isTSSearchRun(r));
  return runs.map((r, order) => {
    let role: PointRole = "intermediate";
    if (isTSSearchRun(r)) role = "ts";
    else if (r === nonTs[0]) role = "reactant";
    else if (r === nonTs[nonTs.length - 1]) role = "product";
    return { runId: r.id, role, order };
  });
}

/**
 * The experiment's run chains: every lineage tree, with in-place
 * follow-up generation and profile assembly from any selection.
 */
export function WorkflowSection({
  expId,
  experimentName,
  runs,
}: {
  expId: string;
  experimentName: string;
  runs: Run[];
}) {
  const ds = useDataSource();
  const nav = useNavigate();
  const prompt = usePrompt();
  const guard = useGuardedAction();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const forest = useMemo(() => buildWorkflowForest(runs), [runs]);
  const flat = useMemo(() => flattenForest(forest.chains), [forest]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Selection resolved in document order so the profile reads left to right.
  const selectedRuns = useMemo(() => {
    const inTree = flat.filter((f) => selected.has(f.node.run.id)).map((f) => f.node.run);
    const treeIds = new Set(inTree.map((r) => r.id));
    return [...inTree, ...runs.filter((r) => selected.has(r.id) && !treeIds.has(r.id))];
  }, [flat, runs, selected]);

  const buildProfile = async () => {
    const name = await prompt({
      title: "Reaction profile name",
      placeholder: "e.g. SN2 chloride exchange",
      validate: (v) => (v.trim().length === 0 ? "Name cannot be empty." : null),
    });
    if (name == null) return;
    await guard("create pathway", async () => {
      nav(routes.pathway(expId, await ds.createPathway(expId, name.trim(), selectionToPoints(selectedRuns))));
    });
  };

  return (
    <div className="pathway-section">
      <div className="section-heading">
        <h2 className="section-title">Workflow</h2>
        <div className="section-rule" />
        {selectedRuns.length >= 2 && (
          <button className="tag-pill run-tag-add" onClick={buildProfile}>
            Build profile from {selectedRuns.length} runs →
          </button>
        )}
      </div>
      {forest.chains.length === 0 ? (
        <div className="muted" style={{ fontSize: 13 }}>
          No chained runs yet. Chain from any run page, or link a parent there — the trees show up here.
        </div>
      ) : (
        <ul className="wf-tree">
          {flat.map(({ node, depth }) => (
            <WorkflowNodeRow
              key={node.run.id}
              node={node}
              depth={depth}
              expId={expId}
              experimentName={experimentName}
              partners={runs}
              selected={selected}
              onToggle={toggle}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
