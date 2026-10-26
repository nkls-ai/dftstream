// Free-form run chaining: the lineage forest of an experiment and which
// follow-ups a run's state can feed. There is no prescribed workflow —
// any run chains into any generator whose inputs it satisfies; the tree
// only visualizes the links the scientist has made. Pure and React-free.

import type { Run } from "../data/types";
import type { FollowupKind } from "./followup";

export interface WorkflowNode {
  run: Run;
  /** Runs generated from this one, oldest first. */
  children: WorkflowNode[];
}

export interface WorkflowForest {
  /** Lineage trees with at least one edge, oldest root first. */
  chains: WorkflowNode[];
  /** Runs that appear in some chain. */
  linkedCount: number;
}

function countNodes(n: WorkflowNode): number {
  return 1 + n.children.reduce((s, c) => s + countNodes(c), 0);
}

/**
 * Builds the lineage forest from `parentRunId` links. Single-run "trees"
 * are dropped — an unlinked run carries no chain information and already
 * lives in the runs table. A parent cycle (possible via manual edits)
 * is broken at its oldest member so no run silently disappears.
 */
export function buildWorkflowForest(runs: Run[]): WorkflowForest {
  const nodes = new Map<string, WorkflowNode>(runs.map((r) => [r.id, { run: r, children: [] }]));
  const roots: WorkflowNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.run.parentRunId ? nodes.get(node.run.parentRunId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }

  // Nodes unreachable from any root form parent cycles; re-root each
  // cycle at its oldest run (its child edge back into the cycle is cut).
  const reachable = new Set<string>();
  const mark = (n: WorkflowNode) => {
    if (reachable.has(n.run.id)) return;
    reachable.add(n.run.id);
    n.children.forEach(mark);
  };
  roots.forEach(mark);
  const orphans = [...nodes.values()]
    .filter((n) => !reachable.has(n.run.id))
    .sort((a, b) => a.run.startedAt - b.run.startedAt);
  for (const n of orphans) {
    if (reachable.has(n.run.id)) continue;
    const parent = nodes.get(n.run.parentRunId!);
    if (parent) parent.children = parent.children.filter((c) => c !== n);
    roots.push(n);
    mark(n);
  }

  for (const n of nodes.values()) n.children.sort((a, b) => a.run.startedAt - b.run.startedAt);
  const chains = roots
    .filter((n) => n.children.length > 0)
    .sort((a, b) => a.run.startedAt - b.run.startedAt);
  return { chains, linkedCount: chains.reduce((s, n) => s + countNodes(n), 0) };
}

/** Depth-first flatten with depth, for list-style rendering and tests. */
export function flattenForest(chains: WorkflowNode[]): { node: WorkflowNode; depth: number }[] {
  const out: { node: WorkflowNode; depth: number }[] = [];
  const walk = (n: WorkflowNode, depth: number) => {
    out.push({ node: n, depth });
    n.children.forEach((c) => walk(c, depth + 1));
  };
  chains.forEach((r) => walk(r, 0));
  return out;
}

export interface FollowupOption {
  kind: FollowupKind;
  /** neb-ts consumes a second run — the UI must offer a partner picker. */
  needsPartner: boolean;
}

/**
 * Which generators this run can feed right now. Availability only — the
 * scientist decides what to actually chain, in whatever order.
 */
export function availableFollowups(run: Run): FollowupOption[] {
  const out: FollowupOption[] = [];
  const converged = run.converged === true;
  if (converged && run.imaginaryModes === 1) out.push({ kind: "irc", needsPartner: false });
  if ((run.runTypes ?? []).includes("IRC") && run.status === "finished") {
    out.push({ kind: "opt-endpoints", needsPartner: false });
  }
  if (converged) {
    out.push({ kind: "neb-ts", needsPartner: true });
    out.push({ kind: "sp", needsPartner: false });
  }
  return out;
}
