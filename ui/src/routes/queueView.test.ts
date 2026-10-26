import { expect, test } from "bun:test";
import type { QueuedJob } from "../data/DataSource";
import {
  canRequestCancel,
  queueAgeLabel,
  queueJobLabel,
  queueStateChip,
  visibleQueuedJobs,
} from "./queueView";

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
    submittedAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

test("linked jobs collapse into their run row once the run is loaded", () => {
  const jobs = [
    job({ id: "a", state: "running", linkedRunId: "run1" }),
    job({ id: "b", state: "pending", submittedAt: 2_000 }),
    // Linked to a run the list does not hold (deleted or truncated): stays
    // visible instead of silently vanishing.
    job({ id: "c", state: "running", linkedRunId: "run-gone", submittedAt: 3_000 }),
  ];
  const visible = visibleQueuedJobs(jobs, new Set(["run1"]));
  expect(visible.map((j) => j.id)).toEqual(["c", "b"]);
});

test("visible jobs are newest first", () => {
  const jobs = [
    job({ id: "old", submittedAt: 1 }),
    job({ id: "new", submittedAt: 2 }),
  ];
  expect(visibleQueuedJobs(jobs, new Set()).map((j) => j.id)).toEqual([
    "new",
    "old",
  ]);
});

test("terminal unlinked jobs stay visible (that outcome is the point)", () => {
  const jobs = [job({ id: "x", state: "cancelled" })];
  expect(visibleQueuedJobs(jobs, new Set()).length).toBe(1);
});

test("cancel is offered only for active, not-yet-requested jobs", () => {
  expect(canRequestCancel(job({ state: "pending" }))).toBe(true);
  expect(canRequestCancel(job({ state: "running" }))).toBe(true);
  expect(canRequestCancel(job({ state: "unknown" }))).toBe(true);
  expect(canRequestCancel(job({ state: "completed" }))).toBe(false);
  expect(canRequestCancel(job({ state: "failed" }))).toBe(false);
  expect(canRequestCancel(job({ state: "cancelled" }))).toBe(false);
  expect(canRequestCancel(job({ state: "pending", cancelRequested: true }))).toBe(
    false,
  );
});

test("state chips reuse the run badge palette where meanings coincide", () => {
  expect(queueStateChip("pending")).toEqual({
    className: "badge pending",
    label: "PENDING",
  });
  // A completed queue job renders like a finished run.
  expect(queueStateChip("completed").className).toBe("badge finished");
  expect(queueStateChip("cancelled").className).toBe("badge cancelled");
  expect(queueStateChip("unknown").className).toBe("badge unknown");
});

test("age labels are coarse and monotone", () => {
  const now = 10 * 24 * 60 * 60 * 1_000;
  expect(queueAgeLabel(now - 30_000, now)).toBe("just now");
  expect(queueAgeLabel(now - 5 * 60_000, now)).toBe("5m ago");
  expect(queueAgeLabel(now - 90 * 60_000, now)).toBe("1h 30m ago");
  expect(queueAgeLabel(now - 26 * 60 * 60_000, now)).toBe("1d 2h ago");
  // A clock skewed into the future must not render a negative age.
  expect(queueAgeLabel(now + 60_000, now)).toBe("just now");
});

test("array jobs are labelled with their array shape", () => {
  expect(queueJobLabel(job({}))).toBe("opt-freq_x.inp");
  expect(queueJobLabel(job({ inputBasename: "batch", arraySpec: "1-24%8" }))).toBe(
    "batch (array 1-24%8)",
  );
});
