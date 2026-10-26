import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { QueueTable } from "./ExperimentQueueSection";
import type { QueuedJob } from "../data/DataSource";

function job(overrides: Partial<QueuedJob>): QueuedJob {
  return {
    id: "qj1",
    experimentId: "exp1",
    cluster: "hpc1",
    scheduler: "slurm",
    schedulerJobId: "4242",
    inputBasename: "opt-freq_x.inp",
    state: "pending",
    cancelRequested: false,
    submittedAt: Date.now() - 5 * 60_000,
    updatedAt: Date.now(),
    ...overrides,
  };
}

const noopCancel = () => Promise.resolve();

test("renders one row per job with state chip, cluster, id and cancel button", () => {
  const html = renderToString(
    <QueueTable
      jobs={[job({}), job({ id: "qj2", schedulerJobId: "4243", state: "running" })]}
      requestCancel={noopCancel}
    />,
  );
  expect(html).toContain("opt-freq_x.inp");
  expect(html).toContain("PENDING");
  expect(html).toContain("RUNNING");
  expect(html).toContain("hpc1");
  expect(html).toContain("4242");
  expect(html).toContain("4243");
  // Cancel is a request executed by the login-node watcher; the UI says so.
  expect(html).toContain("Cancel");
  expect(html).toContain("login-node watcher");
});

test("a job with a cancel already requested shows the pending note, not the button", () => {
  const html = renderToString(
    <QueueTable jobs={[job({ cancelRequested: true })]} requestCancel={noopCancel} />,
  );
  expect(html).toContain("cancel requested");
  expect(html).not.toContain(">Cancel<");
});

test("terminal jobs offer no cancel affordance", () => {
  const html = renderToString(
    <QueueTable jobs={[job({ state: "failed" })]} requestCancel={noopCancel} />,
  );
  expect(html).toContain("FAILED");
  expect(html).not.toContain(">Cancel<");
  expect(html).not.toContain("cancel requested");
});

test("array jobs display their array shape", () => {
  const html = renderToString(
    <QueueTable
      jobs={[job({ inputBasename: "batch", arraySpec: "1-24%8", taskCount: 24 })]}
      requestCancel={noopCancel}
    />,
  );
  expect(html).toContain("batch (array 1-24%8)");
});
