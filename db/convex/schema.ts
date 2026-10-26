import { defineSchema, defineTable } from "convex/server";
import { v, type Infer } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

// Single source of truth for run lifecycle states. Use these members instead
// of raw "pending"/"running"/… literals anywhere outside this file.
export const RUN_STATUS = {
  PENDING: "pending",
  RUNNING: "running",
  FINISHED: "finished",
  FAILED: "failed",
} as const;

export const runStatus = v.union(
  v.literal(RUN_STATUS.PENDING),
  v.literal(RUN_STATUS.RUNNING),
  v.literal(RUN_STATUS.FINISHED),
  v.literal(RUN_STATUS.FAILED),
);

export type RunStatus = Infer<typeof runStatus>;

// Organization permission tiers, highest to lowest. Compared via roleRank in
// authz.ts: viewer < member < admin < owner. Use these members instead of raw
// "owner"/"admin"/… literals anywhere outside this file.
export const ORG_ROLE = {
  OWNER: "owner",
  ADMIN: "admin",
  MEMBER: "member",
  VIEWER: "viewer",
} as const;

export const orgRole = v.union(
  v.literal(ORG_ROLE.OWNER),
  v.literal(ORG_ROLE.ADMIN),
  v.literal(ORG_ROLE.MEMBER),
  v.literal(ORG_ROLE.VIEWER),
);

// CLI browser-link handshake states (see cliLinks table + http.ts). Use these
// members instead of raw "pending"/"approved"/"consumed" literals.
export const CLI_LINK_STATUS = {
  PENDING: "pending",
  APPROVED: "approved",
  CONSUMED: "consumed",
} as const;

export const cliLinkStatus = v.union(
  v.literal(CLI_LINK_STATUS.PENDING),
  v.literal(CLI_LINK_STATUS.APPROVED),
  v.literal(CLI_LINK_STATUS.CONSUMED),
);

// Scheduler-queue lifecycle of a submitted-but-not-necessarily-started job
// (see queuedJobs table + queue.ts). A coarse mirror of SLURM's job states:
// the login-node watcher (`dftstream queue`) maps squeue/sacct output onto
// these members (wrapper/internal/queue/state.go is the Go mirror). Use these
// members instead of raw literals.
export const QUEUED_JOB_STATE = {
  PENDING: "pending", // sitting in the scheduler queue (PD, CF, RQ, …)
  RUNNING: "running", // on a node (R, CG, S)
  COMPLETED: "completed", // finished with exit 0 (CD)
  FAILED: "failed", // finished non-zero / killed by the scheduler (F, TO, OOM, NF, BF, DL)
  CANCELLED: "cancelled", // scancel'd (CA, PR, RV)
  UNKNOWN: "unknown", // the watcher could not classify what the scheduler said
} as const;

export const queuedJobState = v.union(
  v.literal(QUEUED_JOB_STATE.PENDING),
  v.literal(QUEUED_JOB_STATE.RUNNING),
  v.literal(QUEUED_JOB_STATE.COMPLETED),
  v.literal(QUEUED_JOB_STATE.FAILED),
  v.literal(QUEUED_JOB_STATE.CANCELLED),
  v.literal(QUEUED_JOB_STATE.UNKNOWN),
);

export type QueuedJobState = Infer<typeof queuedJobState>;

// Batch system a queued job was submitted through. Mirrors the wrapper's
// submit.Scheduler enum (wrapper/internal/submit/enums.go); closed on purpose
// — adding a scheduler is a coordinated wrapper+schema change.
export const QUEUE_SCHEDULER = {
  SLURM: "slurm",
} as const;

export const queueScheduler = v.union(v.literal(QUEUE_SCHEDULER.SLURM));

// Artifact kinds the Go wrapper is KNOWN to write (see classify() in
// wrapper/internal/artifacts/artifacts.go). The schema column stays an open
// v.string() on purpose: the wrapper adds new kinds without a coordinated
// schema deploy, so a closed union here would reject uploads from newer
// wrappers. Consumers that filter by kind must use these members.
export const ARTIFACT_KIND = {
  INPUT: "input",
  STDOUT: "stdout",
  OUTPUT: "output",
  PROPERTY: "property",
  CUBE: "cube",
  VIBMODE: "vibmode",
  GOAT_MINIMUM: "goat_minimum",
  GOAT_ENSEMBLE: "goat_ensemble",
  TRJ: "trj",
  OTHER: "other",
} as const;

// How an artifact's storage blob is encoded. Unlike ARTIFACT_KIND this IS a
// closed union: a reader that meets an encoding it cannot decode would hand
// back corrupt scientific data, so an unknown value must be rejected at the
// door rather than stored and guessed at later. Adding an encoding means
// deploying the schema before any wrapper writes it.
export const ARTIFACT_ENCODING = {
  // Body stored verbatim. Also the meaning of an ABSENT encoding field, which
  // is what every artifact written before compression existed looks like.
  IDENTITY: "identity",
  // A single zstd frame (RFC 8878). Written by the Go wrapper; decoded lazily
  // in the browser.
  ZSTD: "zstd",
} as const;

export type ArtifactEncoding =
  (typeof ARTIFACT_ENCODING)[keyof typeof ARTIFACT_ENCODING];

export const artifactEncoding = v.union(
  v.literal(ARTIFACT_ENCODING.IDENTITY),
  v.literal(ARTIFACT_ENCODING.ZSTD),
);

// Why an ORCA run failed or stalled, as classified by the wrapper's parser
// (see wrapper/internal/parser/diagnostics.go). Kept as an open v.string()
// column for the same reason as ARTIFACT_KIND: a newer wrapper must be able to
// report a class this deployment has never heard of rather than have the whole
// status update rejected — dropping tracking is worse than an unknown label.
// Consumers that group or filter by class must use these members.
export const ERROR_CLASS = {
  SCF_NOT_CONVERGED: "scf_not_converged",
  OPT_MAX_CYCLES: "opt_max_cycles",
  OUT_OF_MEMORY: "out_of_memory",
  DISK_OR_SCRATCH: "disk_or_scratch",
  GEOMETRY_EXPLODED: "geometry_exploded",
  CHARGE_MULT_IMPOSSIBLE: "charge_mult_impossible",
  UNSTABLE_WAVEFUNCTION: "unstable_wavefunction",
  BASIS_OR_ECP_MISSING: "basis_or_ecp_missing",
  EXTERNAL_TOOL_FAILED: "external_tool_failed",
  INPUT_ERROR: "input_error",
  UNKNOWN: "unknown",
} as const;

export type ErrorClass = (typeof ERROR_CLASS)[keyof typeof ERROR_CLASS];

// Role of one point along a reaction pathway. Use these members instead of
// raw "reactant"/"ts"/… literals anywhere outside this file.
export const PATHWAY_POINT_ROLE = {
  REACTANT: "reactant",
  TS: "ts",
  INTERMEDIATE: "intermediate",
  PRODUCT: "product",
} as const;

export const pathwayPointRole = v.union(
  v.literal(PATHWAY_POINT_ROLE.REACTANT),
  v.literal(PATHWAY_POINT_ROLE.TS),
  v.literal(PATHWAY_POINT_ROLE.INTERMEDIATE),
  v.literal(PATHWAY_POINT_ROLE.PRODUCT),
);

// One pathway point. Shared by the pathways table and the pathways.ts
// create/updatePoints arg validators.
export const pathwayPoint = v.object({
  runId: v.id("runs"),
  role: pathwayPointRole,
  order: v.number(),
});

// --- Shared column objects ---------------------------------------------------
//
// Each *Columns / *Fields object below is spread into BOTH defineTable(...)
// and the arg validators of the module that writes the table, so a column is
// declared exactly once. The per-run child tables share their non-runId
// columns (the mutation supplies runId itself).

export const runColumns = {
  experimentId: v.id("experiments"),
  batchId: v.optional(v.id("batches")),
  batchParams: v.optional(
    v.record(v.string(), v.union(v.string(), v.number(), v.boolean())),
  ),
  name: v.optional(v.string()),
  // Workflow lineage: the run this one was generated from (restart /
  // `dftstream next` provenance) and the kind of follow-up edge
  // (neb-ts | irc | endpoint-opt | sp | restart).
  parentRunId: v.optional(v.id("runs")),
  parentEdgeKind: v.optional(v.string()),
  status: runStatus,
  exitCode: v.optional(v.number()),
  hostname: v.optional(v.string()),
  ncores: v.optional(v.number()),
  nprocs: v.optional(v.number()),
  maxcoreMb: v.optional(v.number()),
  orcaVersion: v.optional(v.string()),
  jobType: v.optional(v.string()),
  inputPath: v.optional(v.string()),
  inputText: v.optional(v.string()),
  cwd: v.optional(v.string()),
  startedAt: v.number(),
  finishedAt: v.optional(v.number()),
  lastEnergy: v.optional(v.number()),

  // Wallclock duration in seconds as reported by ORCA itself
  // ("TOTAL RUN TIME: ..."). Prefer this over finishedAt-startedAt
  // because for imported (offline-ingested) runs startedAt is just
  // the .out file's mtime and finishedAt is "now".
  wallclockSec: v.optional(v.number()),

  // Parsed from the ORCA simple-input ('!') line(s).
  keywords: v.optional(v.array(v.string())),
  functional: v.optional(v.string()),
  basis: v.optional(v.string()),
  method: v.optional(v.string()),
  runTypes: v.optional(v.array(v.string())),
  scfTier: v.optional(v.string()),
  optTier: v.optional(v.string()),
  grid: v.optional(v.string()),
  solvent: v.optional(v.string()),
  solventModel: v.optional(v.string()),
  corrections: v.optional(v.array(v.string())),
  charge: v.optional(v.number()),
  mult: v.optional(v.number()),
  converged: v.optional(v.boolean()),
  // Optimizer stopped at the cycle limit (ORCA's explicit "did not
  // converge" message) — a stalled opt, not a crash.
  optMaxCycles: v.optional(v.boolean()),
  imaginaryModes: v.optional(v.number()),

  // Thermochemistry (all Hartree), from the last THERMOCHEMISTRY
  // section of the output. Powers the cross-run energy comparison.
  zpeEh: v.optional(v.number()),
  enthalpyEh: v.optional(v.number()),
  entropyCorrEh: v.optional(v.number()),
  gibbsEh: v.optional(v.number()),
  gMinusEEh: v.optional(v.number()),

  // Spin contamination from the last <S**2> block (UHF/UKS only):
  // expectation value and the ideal S*(S+1).
  s2: v.optional(v.number()),
  s2Ideal: v.optional(v.number()),

  // Server-side projections of NEB/IRC artifact data (backfilled from the
  // client-side parsers), so reaction checklists and experiment lists can
  // read barriers/endpoint energies without fetching artifacts.
  nebBarrierEh: v.optional(v.number()),
  nebTsImageIdx: v.optional(v.number()),
  ircFwdEndpointEh: v.optional(v.number()),
  ircBwdEndpointEh: v.optional(v.number()),

  // Why the run failed or stalled — one of ERROR_CLASS (open string, see the
  // constant) plus a short excerpt of the output around the diagnosis, so a
  // batch dashboard can group failures without fetching every .out artifact.
  errorClass: v.optional(v.string()),
  errorExcerpt: v.optional(v.string()),

  // Lab-notebook layer: free-text markdown note + short tag chips,
  // editable in the UI (not written by the wrapper).
  notes: v.optional(v.string()),
  tags: v.optional(v.array(v.string())),

  submittedBy: v.optional(v.string()),
  // Authenticated creator (org-aware). `submittedBy` stays as the display
  // string; this is the identity used for "members delete own" checks.
  submittedByUserId: v.optional(v.id("appUsers")),
  // dftstream wrapper build that tracked this run (e.g. "v1.0.0").
  dftstreamVersion: v.optional(v.string()),
  // The same, as written by builds from before the project was renamed from
  // OrcaStream. Nothing writes it any more; readers fall back to it.
  orcastreamVersion: v.optional(v.string()),
  // Scheduler job id the run executes under, read from SLURM_JOB_ID (array
  // tasks: "<arrayJobId>_<taskIdx>") by `dftstream run` at startup. Lets a
  // run be tied to its queuedJobs row (see runs.insertRun's link step).
  schedulerJobId: v.optional(v.string()),
  // Backfill bookkeeping, stamped only by reimport.apply (`dftstream
  // reimport --fix`): when the parser-derived fields were last recomputed,
  // and by which wrapper build. Never written on the live-run path.
  reimportedAt: v.optional(v.number()),
  reimportedWith: v.optional(v.string()),
};

// Denormalized per-batch tallies, maintained transactionally by the same
// mutations that write run state. A high-throughput batch can hold thousands
// of runs, so the dashboard must never scan them: every headline figure below
// is a counter updated on the run's *status transition*, which keeps re-imports
// and restarts consistent. Sums (not samples) are stored so spread and means
// are derivable without keeping per-run rows around.
export const batchProgressFields = {
  batchId: v.id("batches"),
  // Denormalized so org gating can run without a second lookup.
  experimentId: v.id("experiments"),

  // Status tallies. Mirrors RUN_STATUS; total is the sum of the four.
  total: v.number(),
  pending: v.number(),
  running: v.number(),
  finished: v.number(),
  failed: v.number(),

  // Quality tallies over runs that reached a terminal state.
  converged: v.number(),
  notConverged: v.number(),
  optMaxCycles: v.number(),
  withImaginary: v.number(),
  missingThermo: v.number(),
  suspicious: v.number(),

  // Timing and compute. sumSq gives the spread (and thus an ETA range)
  // without retaining every run's wallclock; coreSeconds is Σ wallclock×nprocs,
  // the number a PI on a shared allocation actually asks for.
  wallclockSumSec: v.number(),
  wallclockSumSqSec: v.number(),
  coreSecondsSum: v.number(),
  firstStartedAt: v.optional(v.number()),
  lastFinishedAt: v.optional(v.number()),

  // Energy scale. minEnergyEh keeps a paginated table's relative energies
  // referenced to the whole batch, not just the loaded page.
  minEnergyEh: v.optional(v.number()),
  energySumEh: v.number(),
  energyCount: v.number(),

  // ERROR_CLASS member → count. Open keys for the same reason the column is.
  failureCounts: v.record(v.string(), v.number()),

  updatedAt: v.number(),
};

// Denormalized per-experiment tallies, the experiment-list counterpart of
// batchProgress and maintained the same way: every mutation that writes a run
// APPENDS a signed delta row, reads sum the rows, and a compaction pass folds
// them back into one. An experiment can hold tens of thousands of runs, so the
// experiments index must never scan them — reading 500 run documents per card
// blew Convex's per-query read budget the moment a single experiment got large.
//
// What is NOT here: the latest run's id/name/status and lastActivity. Those
// change under `runs.rename` (which the rollup has no hook into) and would go
// stale, and reading them costs exactly one document per experiment
// (`by_experiment_started`, descending, take 1), so they stay a direct read.
export const experimentProgressFields = {
  experimentId: v.id("experiments"),

  // Status tallies. `running` is pending+running, matching the single
  // "N running" figure the experiment card shows.
  total: v.number(),
  running: v.number(),
  finished: v.number(),
  failed: v.number(),

  // value → number of runs using it, for the card's "most-used" chips. Open
  // keys: a functional/basis string is whatever the ORCA input said.
  functionalCounts: v.record(v.string(), v.number()),
  basisCounts: v.record(v.string(), v.number()),
  runTypeCounts: v.record(v.string(), v.number()),

  updatedAt: v.number(),
};

export const eventFields = {
  seq: v.number(),
  ts: v.number(),
  kind: v.string(),
  payload: v.any(),
};

export const logFields = {
  ts: v.number(),
  level: v.string(),
  message: v.string(),
  fields: v.optional(v.any()),
};

export const metricFields = {
  key: v.string(),
  ts: v.number(),
  cycle: v.optional(v.number()),
  iter: v.optional(v.number()),
  value: v.number(),
};

export const frequencyFields = {
  idx: v.number(),
  wavenumber: v.number(),
  imaginary: v.boolean(),
  irIntensity: v.optional(v.number()),
  /** 1-based hessian ordinal; absent on rows from pre-history wrappers. */
  hessIdx: v.optional(v.number()),
};

export const sysSampleFields = {
  ts: v.number(),
  cpuPct: v.number(),
  rssMb: v.number(),
  threads: v.number(),
};

export const nmrShieldFields = {
  atomIdx: v.number(),
  element: v.string(),
  isotropic: v.number(),
  anisotropy: v.number(),
};

export const excitedStateFields = {
  idx: v.number(),
  energyEv: v.number(),
  wavelengthNm: v.number(),
  oscStrength: v.number(),
  transitions: v.optional(v.string()),
};

export const artifactFields = {
  name: v.string(),            // basename
  path: v.string(),            // absolute path on host that produced it
  kind: v.string(),            // open domain — known values in ARTIFACT_KIND
  sizeBytes: v.number(),       // size of the ORIGINAL file, always uncompressed
  mtime: v.number(),
  contentText: v.optional(v.string()), // present for small text files;
                                        //  for chunked artifacts this is
                                        //  the head preview only.
                                        //  ALWAYS plain text — never encoded.
  truncated: v.optional(v.boolean()),  // true when content was capped
  storageId: v.optional(v.id("_storage")), // full body in file storage when
                                        //  larger than the inline preview
  encoding: v.optional(artifactEncoding), // how the STORAGE BLOB is encoded.
                                        //  Absent = "identity": every row
                                        //  written before compression existed,
                                        //  and every UI-side upload. Readers
                                        //  must default to identity, never
                                        //  sniff the bytes.
  storageBytes: v.optional(v.number()), // encoded size of the storage blob,
                                        //  i.e. what the download actually
                                        //  transfers. Absent on old rows.
  chunked: v.optional(v.boolean()),    // LEGACY: full text in artifactChunks.
                                        //  New uploads use storageId instead;
                                        //  kept so old rows still read back.
  numChunks: v.optional(v.number()),   // LEGACY: expected chunk count for
                                        //  detecting incomplete chunked uploads
};

export default defineSchema({
  // convex-auth's own tables (users, authAccounts, authSessions,
  // authRefreshTokens, authVerificationCodes, …). Active only when the
  // convex-auth Password provider is configured; empty in Clerk deployments.
  // Our org layer never reads these — it keys off `appUsers` instead, so the
  // same code path works for every provider.
  ...authTables,

  // Provider-agnostic identity. One row per authenticated principal, keyed by a
  // STABLE token identifier (issuer + userId) — NOT the raw JWT tokenIdentifier,
  // whose convex-auth subject embeds a per-login sessionId that would mint a new
  // row every sign-in. See authz.stableTokenIdentifier. The same row is reused
  // whether the user signed in via convex-auth, Clerk, or a DFTStream CLI
  // token. JIT-provisioned by authz.currentUserId(). Deliberately NOT named
  // `users` to avoid colliding with convex-auth's own table.
  appUsers: defineTable({
    tokenIdentifier: v.string(),
    // Always stored normalized (trimmed, lowercase) — authz.normalizeEmail.
    // by_email is exact-match, so an un-normalized write is uninvitable.
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    createdAt: v.number(),
    // Coarse (hour-granular) last-activity stamp, refreshed by
    // authz.currentUserId. Shown to admins reviewing an invite candidate so
    // they can judge whether the account looks like the person they meant.
    lastSeenAt: v.optional(v.number()),
  })
    .index("by_token", ["tokenIdentifier"])
    // Lets admins add members by email (the invitee must have signed in at
    // least once, which provisions their row via users.ensureSelf).
    .index("by_email", ["email"]),

  // Invitations addressed to an email that has no account yet, written by
  // organizations.addMember. NEVER auto-redeemed: the Password provider does
  // not verify email ownership, so binding a membership to whoever signs up
  // with the address first would hand the org to a squatter. The invite is
  // consumed only when an admin explicitly confirms the grant against a
  // specific account (addMember with confirmUserId) after reviewing it.
  orgInvites: defineTable({
    organizationId: v.id("organizations"),
    // Always normalized (trimmed, lowercase) — authz.normalizeEmail.
    email: v.string(),
    role: orgRole,
    invitedBy: v.id("appUsers"),
    createdAt: v.number(),
  })
    .index("by_org", ["organizationId"])
    .index("by_org_email", ["organizationId", "email"]),

  organizations: defineTable({
    name: v.string(),
    slug: v.string(), // url-safe, unique
    createdAt: v.number(),
    createdBy: v.id("appUsers"),
  })
    .index("by_slug", ["slug"])
    .index("by_createdAt", ["createdAt"]),

  // user ↔ org join with a role. by_user_org gives O(1) membership lookups.
  memberships: defineTable({
    appUserId: v.id("appUsers"),
    organizationId: v.id("organizations"),
    role: orgRole,
    createdAt: v.number(),
  })
    .index("by_user", ["appUserId"])
    .index("by_org", ["organizationId"])
    .index("by_user_org", ["appUserId", "organizationId"]),

  // Short-lived handshake rows backing the `dftstream login` browser-link
  // flow (RFC 8628-shaped): the CLI starts one (status "pending"), the
  // logged-in UI approves it by USER code (binds appUserId+organizationId,
  // status "approved"), and the CLI polls by DEVICE code until it can mint a
  // token (status "consumed"). See http.ts.
  cliLinks: defineTable({
    // The DEVICE code: the CLI-held secret. Returned only in the
    // /cli/link/start response body, sent back only in /cli/link/poll — it
    // never appears in any URL, page, or log a bystander could see. Holding
    // it (plus an approval) is what yields tokens.
    code: v.string(),
    // The short human-facing USER code. This is the only value that travels
    // through the browser (`/cli-link?userCode=…`), so it must not be able to
    // yield tokens: it only lets a signed-in human target the approval.
    // Cleared once the link is consumed so historic sessions never collide
    // with a fresh handshake's code space.
    userCode: v.optional(v.string()),
    status: cliLinkStatus,
    appUserId: v.optional(v.id("appUsers")),
    organizationId: v.optional(v.id("organizations")),
    // sha256 hex digest of the long-lived refresh secret minted on consume.
    // The plaintext token exists only in the /cli/link/poll and /refresh HTTP
    // responses; a database leak alone can no longer replay a session. (Field
    // keeps its historical name because the by_refresh index names it.)
    refreshToken: v.optional(v.string()),
    // Digest of the immediately superseded refresh token (rotation, see
    // cliLinks.redeemRefresh). Presenting it outside the rotation grace
    // window is reuse of a stolen credential and revokes the whole link.
    prevRefreshToken: v.optional(v.string()),
    // When the current refreshToken digest was minted (consume or rotation).
    // Bounds the grace window in which the superseded token is still honored
    // for concurrent refreshes from parallel jobs sharing credentials.json.
    rotatedAt: v.optional(v.number()),
    createdAt: v.number(),
    // RFC 8628 `slow_down` accounting: last accepted poll and total polls for
    // this handshake. Enforced in cliLinks.registerPoll.
    lastPollAt: v.optional(v.number()),
    pollCount: v.optional(v.number()),
    // Deadline for the PENDING→APPROVED→CONSUMED handshake. An unbounded
    // pending code is a device-code phishing link that never goes stale, and
    // an unbounded row is unauthenticated storage growth (/cli/link/start
    // needs no credential). Absent on rows written before expiry existed —
    // treated as expired.
    expiresAt: v.optional(v.number()),
    // Absolute end of the refresh token's life, set at consume time. A CLI
    // session cannot outlive this no matter how often it refreshes.
    refreshExpiresAt: v.optional(v.number()),
    // Set by cliLinks.revoke. A revoked session can never mint another access
    // token; the outstanding one dies at its own (1h) expiry.
    revokedAt: v.optional(v.number()),
    // Last successful refresh, so the UI can show "last used" next to a
    // session the user is deciding whether to revoke.
    lastUsedAt: v.optional(v.number()),
  })
    .index("by_code", ["code"])
    // Approval targeting only — never token issuance.
    .index("by_user_code", ["userCode"])
    .index("by_refresh", ["refreshToken"])
    // Reuse detection for rotated-out refresh tokens.
    .index("by_prev_refresh", ["prevRefreshToken"])
    // Lists a user's CLI sessions for the revoke UI.
    .index("by_user", ["appUserId"])
    // Drives the bounded sweep of expired handshake rows in cliLinks.start
    // and the crons.ts sweep.
    .index("by_status_expiresAt", ["status", "expiresAt"]),

  // Org-scoped machine tokens for non-interactive auth (SLURM/batch — see
  // machineTokens.ts and the /cli/token/exchange route in http.ts). The token
  // itself IS the long-lived credential: there is no refresh chain. Only the
  // sha256 digest of the secret is ever stored; the plaintext leaves the
  // backend exactly once, in the create mutation's return value.
  machineTokens: defineTable({
    organizationId: v.id("organizations"),
    // Human label ("cluster-A batch jobs") shown in the settings UI.
    name: v.string(),
    // sha256 hex digest of the `ost_…` secret. A database leak alone cannot
    // replay a token, mirroring cliLinks.refreshToken.
    digest: v.string(),
    // The admin who minted it. Exchange re-checks this user's live org
    // membership, and the minted access token acts as this user.
    createdByUserId: v.id("appUsers"),
    createdAt: v.number(),
    // Last accepted exchange. Doubles as the per-token throttle window (see
    // machineTokens.redeemExchange) and as the "last used" column the revoke
    // UI shows — the only signal an operator has that a leaked token is live.
    lastUsedAt: v.optional(v.number()),
    // Set by machineTokens.revoke. A revoked token can never be exchanged
    // again; outstanding access tokens die at their own (1h) expiry.
    revokedAt: v.optional(v.number()),
  })
    .index("by_digest", ["digest"])
    // Lists an org's tokens for the settings UI.
    .index("by_org", ["organizationId"]),

  experiments: defineTable({
    name: v.string(),
    createdAt: v.number(),
    // Optional only during the migration window; treated as required in code
    // once "Import unassigned data" has run. The org is the isolation boundary.
    organizationId: v.optional(v.id("organizations")),
    createdBy: v.optional(v.id("appUsers")),
  })
    .index("by_name", ["name"])
    .index("by_createdAt", ["createdAt"])
    .index("by_org_createdAt", ["organizationId", "createdAt"])
    // Experiment names are unique PER ORG (not globally) once orgs exist.
    .index("by_org_name", ["organizationId", "name"]),

  batches: defineTable({
    experimentId: v.id("experiments"),
    name: v.string(),
    description: v.optional(v.string()),
    artifactLevel: v.optional(v.string()),
    createdAt: v.number(),
    createdBy: v.optional(v.id("appUsers")),
  })
    .index("by_experiment_createdAt", ["experimentId", "createdAt"])
    .index("by_experiment_name", ["experimentId", "name"]),

  // One row per batch. Written only through the run mutations; never by the
  // wrapper directly. Rebuildable from the runs table by a backfill migration.
  batchProgress: defineTable(batchProgressFields).index("by_batch", ["batchId"]),

  // Append-delta rollup rows for one experiment; their sum is the experiment's
  // summary. Several rows per experiment, folded by a compaction pass — see
  // lib/experimentProgressWriter.ts. Rebuildable from the runs table by a
  // backfill migration.
  experimentProgress: defineTable(experimentProgressFields).index(
    "by_experiment",
    ["experimentId"],
  ),

  runs: defineTable(runColumns)
    .index("by_experiment_started", ["experimentId", "startedAt"])
    .index("by_experiment_name", ["experimentId", "name"])
    .index("by_batch_started", ["batchId", "startedAt"])
    .index("by_status", ["status"])
    .index("by_parent", ["parentRunId"]),

  // One row per job handed to a cluster scheduler by `dftstream submit`.
  // Written by the wrapper (register on submit, updateStates from the
  // login-node watcher — the backend can never reach the cluster itself);
  // the UI only reads these and flips cancelRequested. Best-effort by
  // design: a job submitted while the backend is down simply has no row.
  queuedJobs: defineTable({
    experimentId: v.id("experiments"),
    // Denormalized from the experiment AT REGISTER TIME (server-side, never
    // client-supplied) so the watcher's active-jobs query can be indexed.
    organizationId: v.optional(v.id("organizations")),
    // Cluster name from the wrapper's clusters.yaml. Scheduler job ids are
    // only unique per cluster, so every id lookup carries both.
    cluster: v.string(),
    scheduler: queueScheduler,
    // The scheduler's own id, as printed by "Submitted batch job N". For an
    // array job this is the base id; task states are aggregated coarsely.
    schedulerJobId: v.string(),
    // Input file basename for a single job; the array name for -array jobs.
    inputBasename: v.string(),
    // Array jobs only: the --array spec (e.g. "1-24%8") and task count.
    arraySpec: v.optional(v.string()),
    taskCount: v.optional(v.number()),
    state: queuedJobState,
    // Set by queue.requestCancel (UI or CLI). The backend cannot scancel;
    // the login-node watcher acts on this flag at its next poll.
    cancelRequested: v.optional(v.boolean()),
    cancelRequestedAt: v.optional(v.number()),
    // The tracked run this job turned into, once `dftstream run` started
    // under it (matched via runs.schedulerJobId). Single jobs only — an
    // array job maps to many runs and stays unlinked.
    linkedRunId: v.optional(v.id("runs")),
    submittedByUserId: v.optional(v.id("appUsers")),
    submittedAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_experiment", ["experimentId", "submittedAt"])
    // The watcher's "what should I poll" query, org-scoped.
    .index("by_org_state", ["organizationId", "state"])
    // Auth-off deployments have no org to scope by.
    .index("by_state", ["state"])
    // runs.insertRun's link step and `dftstream queue cancel <jobid>`.
    .index("by_scheduler_job", ["schedulerJobId"]),

  events: defineTable({
    runId: v.id("runs"),
    ...eventFields,
  }).index("by_run_seq", ["runId", "seq"]),

  logs: defineTable({
    runId: v.id("runs"),
    ...logFields,
  }).index("by_run_ts", ["runId", "ts"]),

  metrics: defineTable({
    runId: v.id("runs"),
    ...metricFields,
  }).index("by_run_key_ts", ["runId", "key", "ts"]),

  geometries: defineTable({
    runId: v.id("runs"),
    cycle: v.number(),
    ts: v.number(),
    xyz: v.string(),
  }).index("by_run_cycle", ["runId", "cycle"]),

  frequencies: defineTable({
    runId: v.id("runs"),
    ...frequencyFields,
  }).index("by_run_idx", ["runId", "idx"]),

  sysSamples: defineTable({
    runId: v.id("runs"),
    ...sysSampleFields,
  }).index("by_run_ts", ["runId", "ts"]),

  artifacts: defineTable({
    runId: v.id("runs"),
    ...artifactFields,
  })
    .index("by_run_name", ["runId", "name"])
    .index("by_run_kind", ["runId", "kind"])
    // Lets the one-shot chunk→storage migration find unconverted rows without
    // a full-table filter scan. See migrations.ts.
    .index("by_chunked", ["chunked"])
    // Lets deleteBlob verify a blob is orphaned (not referenced by any
    // artifact row) before destroying it.
    .index("by_storage", ["storageId"]),

  // Per-run artifact accounting ledger, maintained transactionally by every
  // artifact write path (see lib/artifactQuota.ts). Exists so that (a) the
  // per-run artifact-count cap is O(1) instead of re-reading every artifact
  // row, and (b) deleting a run can settle the org's usage in the same
  // transaction that pops the run row, without the cascade having to re-read
  // artifacts it is about to drain. organizationId is denormalized at write
  // time because the cascade deletes the run row before the children drain —
  // there is nothing left to resolve the org from afterwards.
  runUsage: defineTable({
    runId: v.id("runs"),
    organizationId: v.optional(v.id("organizations")),
    artifactBytes: v.number(),
    artifactCount: v.number(),
  }).index("by_run", ["runId"]),

  // Per-org total of stored artifact bytes (blob + inline + legacy chunk
  // text), the number the org storage quota is enforced against. One row per
  // org, updated in the same transaction as every artifact write/delete.
  // Rows written before this table existed were never counted, so decrements
  // clamp at zero — the counter can undercount legacy data but never blocks
  // a tenant for bytes they no longer store.
  orgUsage: defineTable({
    organizationId: v.id("organizations"),
    artifactBytes: v.number(),
  }).index("by_org", ["organizationId"]),

  // For text artifacts larger than what fits in a single Convex document,
  // we split the content into ~512 KB chunks and store them here. The
  // artifact row carries metadata + a small head preview; the UI fetches
  // the full body via artifacts:getContent which concatenates chunks in
  // order.
  artifactChunks: defineTable({
    artifactId: v.id("artifacts"),
    idx: v.number(),
    text: v.string(),
  }).index("by_artifact_idx", ["artifactId", "idx"]),

  // One row per one-shot migration, keyed by lib/migrationState.MIGRATION_KEY
  // (chunk→storage, the batchProgress and experimentProgress backfills).
  // `done` lets startup short-circuit once the work is finished; `running`
  // prevents overlapping migration chains; `heartbeatAt` is stamped by the
  // chain as it progresses, so a chain that died mid-way (running stuck true)
  // can be recognized as stale and re-kicked. See migrations.ts.
  migrationState: defineTable({
    // A MigrationKey member. Open v.string() because existing rows predate
    // the enum; see lib/migrationState.ts.
    key: v.string(),
    running: v.boolean(),
    done: v.boolean(),
    // Absent on rows written before stale-chain recovery existed.
    heartbeatAt: v.optional(v.number()),
  }).index("by_key", ["key"]),

  nmrShields: defineTable({
    runId: v.id("runs"),
    ...nmrShieldFields,
  }).index("by_run", ["runId"]),

  excitedStates: defineTable({
    runId: v.id("runs"),
    ...excitedStateFields,
  }).index("by_run_idx", ["runId", "idx"]),

  // Org-shared input-builder templates (P1-1): a named builder state a
  // group can reuse instead of retyping its standard level of theory.
  // `state` is the UI's serialized BuilderState JSON — opaque here, and
  // stamped with `stateVersion` so a client that does not understand the
  // payload refuses it rather than half-reading it. Never carries a
  // structure: a template is a recipe, not a molecule.
  inputTemplates: defineTable({
    // Optional only for local single-user mode (auth off), matching
    // experiments; treated as required whenever auth is enforced.
    organizationId: v.optional(v.id("organizations")),
    name: v.string(),
    description: v.string(),
    state: v.string(),
    stateVersion: v.number(),
    createdBy: v.optional(v.id("appUsers")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org_updatedAt", ["organizationId", "updatedAt"])
    .index("by_updatedAt", ["updatedAt"]),

  pathways: defineTable({
    experimentId: v.id("experiments"),
    name: v.string(),
    createdAt: v.number(),
    createdBy: v.optional(v.id("appUsers")),
    points: v.array(pathwayPoint),
  }).index("by_experiment", ["experimentId"]),

  // Idempotency markers for offline-journal replay (see spool.ts and
  // wrapper/internal/spool). One row per applied journal record, written in
  // the SAME transaction as the record's insert, so a re-replayed key — a
  // sync that crashed after commit but before persisting its client-side
  // cursor — is recognized and skipped instead of duplicating rows. Keys are
  // client-generated ("<random 64-bit journal id>:<seq>"). runId is stored
  // for createRun markers so the retry can return the original result.
  spoolMarkers: defineTable({
    key: v.string(),
    runId: v.optional(v.id("runs")),
    createdAt: v.number(),
  }).index("by_key", ["key"]),
});
