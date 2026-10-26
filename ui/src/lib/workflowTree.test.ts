import { describe, expect, test } from "bun:test";
import type { Run } from "../data/types";
import { availableFollowups, buildWorkflowForest, flattenForest } from "./workflowTree";

let seq = 0;
function run(over: Partial<Run> = {}): Run {
  seq += 1;
  return {
    id: over.id ?? `r${seq}`,
    experimentId: "e1",
    status: "finished",
    startedAt: seq,
    ...over,
  } as Run;
}

describe("buildWorkflowForest", () => {
  test("groups children under their parent, oldest first", () => {
    const a = run({ id: "a" });
    const c = run({ id: "c", parentRunId: "a" });
    const b = run({ id: "b", parentRunId: "a", startedAt: 100 });
    const { chains, linkedCount } = buildWorkflowForest([a, b, c]);
    expect(chains).toHaveLength(1);
    expect(chains[0]!.run.id).toBe("a");
    expect(chains[0]!.children.map((n) => n.run.id)).toEqual(["c", "b"]);
    expect(linkedCount).toBe(3);
  });

  test("drops unlinked runs and dangling parents become roots", () => {
    const loose = run({ id: "loose" });
    const child = run({ id: "child", parentRunId: "gone" });
    const { chains, linkedCount } = buildWorkflowForest([loose, child]);
    expect(chains).toHaveLength(0);
    expect(linkedCount).toBe(0);
  });

  test("multi-level chain keeps depth", () => {
    const opt = run({ id: "opt" });
    const ts = run({ id: "ts", parentRunId: "opt" });
    const irc = run({ id: "irc", parentRunId: "ts" });
    const flat = flattenForest(buildWorkflowForest([opt, ts, irc]).chains);
    expect(flat.map((f) => [f.node.run.id, f.depth])).toEqual([
      ["opt", 0],
      ["ts", 1],
      ["irc", 2],
    ]);
  });

  test("a parent cycle is broken instead of vanishing", () => {
    const a = run({ id: "a", parentRunId: "b" });
    const b = run({ id: "b", parentRunId: "a", startedAt: 100 });
    const { chains, linkedCount } = buildWorkflowForest([a, b]);
    expect(linkedCount).toBe(2);
    expect(chains).toHaveLength(1);
    expect(chains[0]!.run.id).toBe("a"); // oldest member is the root
    expect(chains[0]!.children.map((n) => n.run.id)).toEqual(["b"]);
  });

  test("self-parent is treated as a root", () => {
    const a = run({ id: "a", parentRunId: "a" });
    const b = run({ id: "b", parentRunId: "a" });
    const { chains } = buildWorkflowForest([a, b]);
    expect(chains).toHaveLength(1);
    expect(chains[0]!.run.id).toBe("a");
  });
});

describe("availableFollowups", () => {
  const kinds = (r: Run) => availableFollowups(r).map((o) => o.kind);

  test("converged minimum: neb-ts (partnered) and sp", () => {
    const opts = availableFollowups(run({ converged: true, imaginaryModes: 0 }));
    expect(opts.map((o) => o.kind)).toEqual(["neb-ts", "sp"]);
    expect(opts.find((o) => o.kind === "neb-ts")!.needsPartner).toBe(true);
  });

  test("validated TS additionally feeds an IRC", () => {
    expect(kinds(run({ converged: true, imaginaryModes: 1, runTypes: ["OPTTS", "FREQ"] }))).toEqual([
      "irc",
      "neb-ts",
      "sp",
    ]);
  });

  test("finished IRC feeds endpoint opts even without convergence flag", () => {
    expect(kinds(run({ runTypes: ["IRC"] }))).toEqual(["opt-endpoints"]);
  });

  test("unconverged or running runs feed nothing", () => {
    expect(kinds(run({ converged: false }))).toEqual([]);
    expect(kinds(run({ status: "running", runTypes: ["IRC"] }))).toEqual([]);
  });
});
