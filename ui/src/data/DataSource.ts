import { createContext, useContext } from "react";
import type { BatchRunLike } from "../lib/batchStats";
import type {
  Artifact,
  ArtifactContent,
  ArtifactTextStream,
  Batch,
  BatchProgress,
  CappedQueryResult,
  Experiment,
  ExperimentSummary,
  Frequency,
  Geometry,
  MetricPoint,
  Pathway,
  PathwayPoint,
  QueryResult,
  Run,
  RunEvent,
  RunLog,
  SysSample,
} from "./types";

export interface ExcitedStateRow {
  id: string;
  idx: number;
  energyEv: number;
  wavelengthNm: number;
  oscStrength: number;
  transitions?: string;
}

export interface NMRShieldRow {
  id: string;
  atomIdx: number;
  element: string;
  isotropic: number;
  anisotropy: number;
}

export interface RunThermoPatch {
  zpeEh?: number;
  enthalpyEh?: number;
  entropyCorrEh?: number;
  gibbsEh?: number;
  gMinusEEh?: number;
}

export interface ArtifactUploadResult {
  id: string;
  name: string;
  kind: string;
  sizeBytes: number;
  truncated: boolean;
  chunked: boolean;
}

/** Coarse scheduler-queue lifecycle, mirroring db/convex/schema.ts
 *  QUEUED_JOB_STATE (the single source of truth for the wire values). */
export const QUEUED_JOB_STATES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "unknown",
] as const;

export type QueuedJobState = (typeof QUEUED_JOB_STATES)[number];

/** One scheduler job registered by `dftstream submit` — visible in the UI
 *  before any run exists for it. */
export interface QueuedJob {
  id: string;
  experimentId: string;
  cluster: string;
  scheduler: string;
  schedulerJobId: string;
  inputBasename: string;
  /** Array jobs only: the --array spec, e.g. "1-24%8". */
  arraySpec?: string;
  taskCount?: number;
  state: QueuedJobState;
  cancelRequested: boolean;
  /** The tracked run this job collapsed into once ORCA started under it. */
  linkedRunId?: string;
  submittedAt: number;
  updatedAt: number;
}

/** One saved input-builder template (see db/convex/templates.ts). The
 *  `state` payload is the UI's serialized BuilderState JSON; nothing
 *  reads it without checking `stateVersion` first. */
export interface InputTemplate {
  id: string;
  name: string;
  description: string;
  state: string;
  stateVersion: number;
  createdAt: number;
  updatedAt: number;
}

/** The writable fields of a template. */
export type InputTemplateInput = Pick<
  InputTemplate,
  "name" | "description" | "state" | "stateVersion"
>;

export interface PaginatedQueryResult<T> extends QueryResult<T[]> {
  canLoadMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
}

export type OrgRole = "owner" | "admin" | "member" | "viewer";

export interface OrgMembership {
  organizationId: string;
  name: string;
  slug: string;
  role: OrgRole;
}

export interface OrgMember {
  membershipId: string;
  appUserId: string;
  email: string | null;
  name: string | null;
  role: OrgRole;
}

export interface AccountInfo {
  id: string;
  email: string | null;
  name: string | null;
}

/** One org-scoped machine token (Settings → Machine tokens). Metadata only —
 *  the secret is returned exactly once, by createMachineToken. */
export interface MachineTokenInfo {
  tokenId: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

/** One live browser-linked CLI session of the CURRENT user
 *  (cliLinks.listMine). Revoking kills its refresh chain; the outstanding
 *  access token dies within the hour. */
export interface CliSessionInfo {
  linkId: string;
  organizationId: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
}

/** What the backend knows about the account matching an invited email, shown
 *  to the admin so they can verify OUT-OF-BAND that it belongs to the person
 *  they mean before confirming the grant. */
export interface AddMemberCandidate {
  userId: string;
  email: string;
  name: string | null;
  accountCreatedAt: number;
  lastSeenAt: number | null;
  /** When a pending invite for this email was recorded, if one exists. An
   *  account created AFTER this is the classic pre-registration-hijack
   *  shape. */
  invitePendingSince: number | null;
}

/** Outcome of addOrgMember. Nothing is granted for "invited" (no account
 *  exists yet — re-add once the person has signed in) or
 *  "needs-confirmation" (an account exists but its email is self-asserted;
 *  re-call with confirmUserId = candidate.userId to grant). */
export type AddMemberResult =
  | { status: "added" }
  | { status: "invited" }
  | { status: "needs-confirmation"; candidate: AddMemberCandidate };

export interface DataSource {
  // organizationId scopes the list to one org (required when the deployment
  // enforces auth). Pass "skip" to suspend the query (e.g. before an org is
  // selected) so it doesn't error under auth.
  useExperiments(organizationId?: string | "skip"): QueryResult<Experiment[]>;
  useExperimentsWithSummary(
    pageSize: 10 | 50 | 100,
    organizationId?: string | "skip",
  ): PaginatedQueryResult<ExperimentSummary>;
  useExperiment(id: string): QueryResult<Experiment>;
  useBatchesByExperiment(id: string): QueryResult<Batch[]>;
  useBatch(id: string): QueryResult<Batch>;
  /** The batch's denormalized rollup — one document however many runs the
   *  batch holds. `null` (not undefined) means no rollup exists for this batch
   *  yet: a batch that predates the rollup and has not been backfilled. */
  useBatchProgress(id: string): QueryResult<BatchProgress | null>;
  /** Paginated, projected runs of one batch for the dense table. The rows are
   *  newest-first and never carry `inputText`; batch-wide statistics come from
   *  useBatchProgress, never from counting these. */
  useBatchRuns(id: string, pageSize: number): PaginatedQueryResult<BatchRunLike>;
  // Pass "skip" to suspend (callers that only sometimes have an experiment).
  // The backend caps this list, so the result carries `capped`: when true the
  // array is the newest N runs and NOT the experiment. Any count, denominator
  // or energy reference taken from it has to be presented as partial.
  useRunsByExperiment(id: string): CappedQueryResult<Run[]>;
  // Pass "skip" to suspend (callers that only sometimes have a run id,
  // e.g. the lineage strip resolving an optional parent).
  useRun(id: string | "skip"): QueryResult<Run>;
  // Live subscription to every currently running run (org-scoped when auth
  // is enforced; "skip" suspends, undefined means single-user mode).
  useRunningRuns(organizationId?: string | "skip"): QueryResult<Run[]>;
  // One-shot imperative fetch of a run (e.g. to resolve the final status of
  // a run that just left the running set). Null when the run was deleted.
  fetchRun(id: string): Promise<Run | null>;
  useRunEvents(id: string): QueryResult<RunEvent[]>;
  useRunLogs(id: string): QueryResult<RunLog[]>;
  useRunMetrics(id: string, key: string): QueryResult<MetricPoint[]>;
  useRunGeometries(id: string): QueryResult<Geometry[]>;
  useRunFrequencies(id: string): QueryResult<Frequency[]>;
  useRunSysSamples(id: string): QueryResult<SysSample[]>;
  // Pass "skip" to suspend (callers with an optional run id).
  useRunArtifacts(id: string | "skip"): QueryResult<Artifact[]>;
  useArtifactContent(
    artifactId: string | null,
  ): QueryResult<ArtifactContent | null>;
  useArtifactTextStream(artifactId: string | null): ArtifactTextStream;
  useArtifactFullText(artifactId: string | null): ArtifactTextStream;
  useRunCubeIndex(id: string): QueryResult<CubeMeta[]>;
  useRunVibModes(id: string): QueryResult<VibBlob[]>;
  useRunExcitedStates(id: string): QueryResult<ExcitedStateRow[]>;
  useRunNMRShields(id: string): QueryResult<NMRShieldRow[]>;
  /** Runs generated from this one (restart / `dftstream next` lineage). */
  useRunChildren(id: string): QueryResult<Run[]>;

  // Scheduler queue (jobs submitted via `dftstream submit`, before/beside
  // any tracked run). Live subscription, newest first.
  useQueuedJobsByExperiment(experimentId: string): QueryResult<QueuedJob[]>;
  /** Flags the job for cancellation. Nothing is cancelled immediately: the
   *  backend cannot reach the cluster — the login-node watcher
   *  (`dftstream queue watch`) runs scancel at its next poll. */
  requestCancelQueuedJob(id: string): Promise<void>;

  // Pathways
  usePathwaysByExperiment(experimentId: string): QueryResult<Pathway[]>;
  usePathway(id: string): QueryResult<Pathway>;

  // Input-builder template library (org-shared; implicit org in local
  // mode). Pass "skip" to suspend before an org is selected.
  useInputTemplates(organizationId?: string | "skip"): QueryResult<InputTemplate[]>;
  createInputTemplate(input: InputTemplateInput, organizationId?: string): Promise<string>;
  updateInputTemplate(id: string, input: InputTemplateInput): Promise<void>;
  removeInputTemplate(id: string): Promise<void>;

  // Mutations. Resolve when the backend has applied the change.
  renameExperiment(id: string, name: string): Promise<void>;
  removeExperiment(id: string): Promise<void>;
  createBatch(experimentId: string, name: string): Promise<string>;
  renameBatch(id: string, name: string): Promise<void>;
  removeBatch(id: string): Promise<void>;
  renameRun(id: string, name: string): Promise<void>;
  removeRun(id: string): Promise<void>;
  setRunNotes(id: string, notes: string): Promise<void>;
  setRunTags(id: string, tags: string[]): Promise<void>;
  /** Edits the lineage by hand; parentRunId null unlinks. */
  setRunParent(id: string, parentRunId: string | null, edgeKind?: string): Promise<void>;
  /** One-shot fetch of the run's .out artifact body (null when the run has
   *  no output artifact). Used by the thermo backfill in the Energies tab. */
  fetchRunOutputText(runId: string): Promise<string | null>;
  /** Persists thermochemistry parsed client-side from the .out onto the run
   *  record, so exports and list views stop showing blanks for runs tracked
   *  before the wrapper stored thermo. */
  patchRunThermo(runId: string, patch: RunThermoPatch): Promise<void>;
  uploadRunArtifacts(runId: string, files: File[]): Promise<ArtifactUploadResult[]>;
  removeArtifact(artifactId: string): Promise<void>;
  createPathway(experimentId: string, name: string, points: PathwayPoint[]): Promise<string>;
  renamePathway(id: string, name: string): Promise<void>;
  updatePathwayPoints(id: string, points: PathwayPoint[]): Promise<void>;
  removePathway(id: string): Promise<void>;

  // --- Org / auth ---
  /** Kick the one-shot backfill migrations. Once per page load; call only
   *  when the caller may run them (see startupMigrationsReady) — under
   *  enforcement they need a signed-in member, so kicking at construction
   *  time failed on every load with "not authenticated". */
  kickStartupMigrations(): void;
  /** The backend's meta.version `authRequired`, or null when it does not
   *  report one (older backend). One-shot; rejects on a transport error. */
  getBackendAuthRequired(): Promise<boolean | null>;
  useMe(): QueryResult<AccountInfo | null>;
  useMyOrgs(): QueryResult<OrgMembership[]>;
  useMyRole(organizationId: string | "skip"): QueryResult<OrgRole | null>;
  useOrgMembers(organizationId: string | "skip"): QueryResult<OrgMember[]>;
  ensureSelf(): Promise<void>;
  createOrg(name: string): Promise<{ organizationId: string; slug: string }>;
  renameOrg(organizationId: string, name: string): Promise<void>;
  removeOrg(organizationId: string): Promise<void>;
  /** Three outcomes — see AddMemberResult. Pass confirmUserId (from a
   *  needs-confirmation candidate) to explicitly grant to that account. */
  addOrgMember(
    organizationId: string,
    email: string,
    role: OrgRole,
    confirmUserId?: string,
  ): Promise<AddMemberResult>;
  updateOrgMemberRole(membershipId: string, role: OrgRole): Promise<void>;
  removeOrgMember(membershipId: string): Promise<void>;
  approveCliLink(code: string, organizationId: string): Promise<void>;

  // --- Machine tokens (admin) + own CLI sessions ---
  /** Admin-only; pass "skip" until an org with admin rights is active. */
  useMachineTokens(organizationId: string | "skip"): QueryResult<MachineTokenInfo[]>;
  /** Returns the plaintext secret exactly once — it is never retrievable
   *  again. Callers must show it immediately. */
  createMachineToken(
    organizationId: string,
    name: string,
  ): Promise<{ tokenId: string; name: string; token: string }>;
  revokeMachineToken(tokenId: string): Promise<void>;
  /** The caller's own live browser-linked CLI sessions. */
  useMyCliSessions(): QueryResult<CliSessionInfo[]>;
  revokeCliSession(linkId: string): Promise<void>;
}

export interface CubeMeta {
  id: string;
  createdAt: number;
  name: string;
  sizeBytes: number;
}

export interface VibBlob {
  id: string;
  name: string;
  contentText: string;
}

const DataSourceContext = createContext<DataSource | null>(null);

export const DataSourceProvider = DataSourceContext.Provider;

export function useDataSource(): DataSource {
  const v = useContext(DataSourceContext);
  if (!v) throw new Error("DataSourceProvider missing");
  return v;
}
