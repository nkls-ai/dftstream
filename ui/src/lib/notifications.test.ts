import { describe, expect, test } from "bun:test";
import {
  completionNotification,
  diffDisappeared,
  snapshotRunning,
} from "./notifications";

const runs = [
  { id: "a", name: "water opt", experimentId: "e1" },
  { id: "b", name: undefined, experimentId: "e1" },
];

describe("snapshotRunning", () => {
  test("indexes by id and falls back to the id as name", () => {
    const map = snapshotRunning(runs);
    expect(map.size).toBe(2);
    expect(map.get("a")).toEqual({ id: "a", name: "water opt", experimentId: "e1" });
    expect(map.get("b")!.name).toBe("b");
  });
});

describe("diffDisappeared", () => {
  test("returns runs that left the running set, in prev order", () => {
    const prev = snapshotRunning(runs);
    const current = snapshotRunning([runs[0]!]);
    expect(diffDisappeared(prev, current).map((s) => s.id)).toEqual(["b"]);
    expect(diffDisappeared(prev, prev)).toEqual([]);
    expect(diffDisappeared(new Map(), current)).toEqual([]);
  });
});

describe("completionNotification", () => {
  const snap = { id: "a", name: "water opt", experimentId: "e1" };

  test("carries the resolved status and convergence details", () => {
    const n = completionNotification(
      snap,
      { status: "failed", converged: false, imaginaryModes: 2, runTypes: ["OPT"] },
      1000,
    );
    expect(n).toMatchObject({
      id: "a-1000",
      runId: "a",
      runName: "water opt",
      experimentId: "e1",
      status: "failed",
      converged: false,
      imaginaryModes: 2,
      ts: 1000,
    });
  });

  // The toast renders `converged === false` as "(not converged)". On a job
  // with no geometry to converge that is a scary-looking non-fact — and the
  // wrapper has historically written converged:false on exactly those runs
  // (see the "old bug" note in convergence.ts overviewConvergence).
  test("drops the convergence flag for runs with nothing to converge", () => {
    for (const runTypes of [["SP"], ["FREQ"], ["SCAN"], undefined]) {
      const n = completionNotification(
        snap,
        { status: "finished", converged: false, runTypes },
        1000,
      );
      expect(n.converged).toBeUndefined();
    }
  });

  test("keeps the convergence flag for every convergence-gated run type", () => {
    for (const runTypes of [["OPT"], ["OPTTS"], ["NEB-TS"], ["NEB"], ["COPT"]]) {
      const n = completionNotification(
        snap,
        { status: "finished", converged: false, runTypes },
        1000,
      );
      expect(n.converged).toBe(false);
    }
  });

  test("defaults to finished when the run was deleted", () => {
    expect(completionNotification(snap, null, 1000).status).toBe("finished");
    expect(completionNotification(snap, { status: "finished", converged: true }, 1000).status).toBe("finished");
  });
});
