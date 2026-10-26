// Convex row -> view-type mappers for ConvexDataSource. Pure functions over
// the backend's return types (type-only @db imports), so they stay testable
// and out of the data source's 1000-line class.

import type { FunctionReturnType } from "convex/server";
import type { api } from "@db/api";
import type { BatchRunLike } from "../lib/batchStats";
import type { InputTemplate, QueuedJob } from "./DataSource";
import type { Batch, BatchProgress, ExperimentSummary, Pathway, Run } from "./types";

type ExperimentSummaryRow = FunctionReturnType<
  typeof api.experiments.listWithSummary
>["page"][number];
type PathwayRow = NonNullable<FunctionReturnType<typeof api.pathways.get>>;
type PathwayPointRow = PathwayRow["points"][number];
type InputTemplateRow = FunctionReturnType<typeof api.templates.list>[number];
type RunRow = NonNullable<FunctionReturnType<typeof api.runs.get>>;
type BatchRow = FunctionReturnType<typeof api.experiments.listBatches>[number];
type BatchProgressRow = NonNullable<FunctionReturnType<typeof api.runs.batchProgress>>;
type BatchRunRow = FunctionReturnType<
  typeof api.runs.listByBatchPaged
>["page"][number];

export function normalizePathway(r: PathwayRow): Pathway {
  return {
    id: r._id,
    experimentId: r.experimentId,
    name: r.name,
    createdAt: r.createdAt,
    points: (r.points ?? []).map((p: PathwayPointRow) => ({
      runId: p.runId,
      role: p.role,
      order: p.order,
    })),
  };
}

export function normalizeInputTemplate(r: InputTemplateRow): InputTemplate {
  return {
    id: r._id,
    name: r.name,
    description: r.description,
    state: r.state,
    stateVersion: r.stateVersion,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function normalizeBatch(r: BatchRow): Batch {
  return {
    id: r._id,
    experimentId: r.experimentId,
    name: r.name,
    description: r.description,
    artifactLevel: r.artifactLevel,
    createdAt: r.createdAt,
  };
}

// Spread-based: renames _id → id and drops Convex's system fields, so a
// field added to both the schema and the Run view type flows through
// automatically instead of silently dropping out of a hand-copied list.
export function normalizeRun(r: RunRow): Run {
  const { _id, _creationTime, orcastreamVersion, ...fields } = r;
  // Runs tracked before the rename from OrcaStream carry the wrapper build
  // under its old field name.
  const dftstreamVersion = fields.dftstreamVersion ?? orcastreamVersion;
  return { ...fields, id: _id, ...(dftstreamVersion !== undefined && { dftstreamVersion }) };
}

type QueuedJobRow = FunctionReturnType<
  typeof api.queue.listByExperiment
>[number];

export function normalizeQueuedJob(r: QueuedJobRow): QueuedJob {
  const { _id, _creationTime, organizationId, submittedByUserId, ...fields } = r;
  return {
    ...fields,
    id: _id,
    // Absent means "nobody asked": the flag is set-only on the backend.
    cancelRequested: r.cancelRequested === true,
  };
}

// The backend already merges the batch's rollup rows into one plain object,
// so there is nothing to rename — this only pins the view type to it.
export function normalizeBatchProgress(r: BatchProgressRow): BatchProgress {
  return r;
}

// Same spread trick as normalizeRun: the backend projection and BatchRunLike
// share their field names, so a column added to both flows through instead of
// dropping out of a hand-copied list.
export function normalizeBatchRunRow(r: BatchRunRow): BatchRunLike {
  const { _id, experimentId, ...fields } = r;
  return { ...fields, id: _id };
}

export function normalizeExperimentSummary(r: ExperimentSummaryRow): ExperimentSummary {
  // Summary rows are already backend-constructed projections (no system
  // fields beyond _id), so only the id needs renaming.
  const { _id, ...fields } = r;
  return { ...fields, id: _id };
}
