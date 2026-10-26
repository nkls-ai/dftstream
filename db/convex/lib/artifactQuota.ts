import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

// Server-side artifact quotas. The 128 MB cap in
// wrapper/internal/artifacts/artifacts.go (MaxTextContentBytes) is client-side
// courtesy only — anything with a token can call the mutations directly — so
// the caps that actually protect the deployment live here, enforced inside the
// same transaction as every artifact write.
//
// Three limits, each overridable via an environment variable on the Convex
// deployment:
//
//   DFTSTREAM_MAX_ARTIFACT_BYTES      per-artifact stored bytes (blob as
//                                      stored + inline preview). Default
//                                      mirrors the wrapper's 128 MB cap.
//   DFTSTREAM_MAX_RUN_ARTIFACTS       artifact rows per run.
//   DFTSTREAM_ORG_STORAGE_QUOTA_BYTES total stored artifact bytes per org.
//
// Accounting model: two counter tables (see schema.ts).
//
//   runUsage — per-run ledger of counted bytes + artifact rows, with the
//              owning org denormalized. Charged on every write, credited on
//              every delete; settled wholesale (settleRunUsage) when the run
//              row itself is popped, which is what keeps the org counter
//              correct through the cascade delete without the drain having to
//              re-read the artifacts it destroys.
//   orgUsage — per-org total, the row the quota check reads.
//
// Known, deliberate imprecision:
//   * Rows written before these tables existed were never charged; credits
//     clamp at zero, so legacy data can make the counters UNDERcount (which
//     favors the tenant) but never overcount.
//   * Inline text is counted as string length (UTF-16 code units), not UTF-8
//     bytes. ORCA output is ASCII; the error is negligible and one-sided only
//     for non-BMP text.
//   * A blob uploaded via generateUploadUrl but never attached to a row is
//     not counted (there is no org to charge until it is attached). The
//     attach mutations are where quota bites; orphans are bounded by the
//     uploader cleaning up via deleteBlob. Documented in docs/auth.md.

export const DEFAULT_MAX_ARTIFACT_BYTES = 128 * 1024 * 1024; // 128 MB — mirrors wrapper MaxTextContentBytes
export const DEFAULT_MAX_RUN_ARTIFACTS = 512;
export const DEFAULT_ORG_STORAGE_QUOTA_BYTES = 100 * 1024 * 1024 * 1024; // 100 GiB — deliberately generous

export type ArtifactLimits = {
  maxArtifactBytes: number;
  maxRunArtifacts: number;
  orgQuotaBytes: number;
};

// Strict, fail-closed env parse (same philosophy as authz.authEnabled): a
// malformed override must throw at the first write, not silently fall back to
// a default the operator believes they changed.
function envLimit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `${name}=${JSON.stringify(raw)} is not a valid limit. Use a positive ` +
        `integer number of ${name.endsWith("ARTIFACTS") ? "rows" : "bytes"}, ` +
        `or unset it for the default. Refusing to guess: quotas fail closed ` +
        `on a misconfigured value.`,
    );
  }
  return n;
}

// Read per call (not at module load) so a redeploy-free env change — and the
// test suite's env stubs — take effect immediately.
export function artifactLimits(): ArtifactLimits {
  return {
    maxArtifactBytes: envLimit(
      "DFTSTREAM_MAX_ARTIFACT_BYTES",
      DEFAULT_MAX_ARTIFACT_BYTES,
    ),
    maxRunArtifacts: envLimit(
      "DFTSTREAM_MAX_RUN_ARTIFACTS",
      DEFAULT_MAX_RUN_ARTIFACTS,
    ),
    orgQuotaBytes: envLimit(
      "DFTSTREAM_ORG_STORAGE_QUOTA_BYTES",
      DEFAULT_ORG_STORAGE_QUOTA_BYTES,
    ),
  };
}

// The blob's ACTUAL stored size from the _storage system table — never the
// client-claimed sizeBytes/storageBytes, which are display metadata anyone
// can lie about. Also serves as proof the blob exists at attach time.
export async function storedBlobSize(
  ctx: MutationCtx,
  storageId: Id<"_storage">,
): Promise<number> {
  const meta = await ctx.db.system.get(storageId);
  if (!meta) {
    throw new Error("storage blob not found — upload the body before attaching it");
  }
  return meta.size;
}

type MeasurableItem = {
  name?: string;
  storageId?: Id<"_storage">;
  contentText?: string;
};

// Counted bytes of one artifact item: the blob as actually stored plus the
// inline text. This is the figure charged to the ledgers and checked against
// the per-artifact cap.
export async function measureArtifactItem(
  ctx: MutationCtx,
  item: MeasurableItem,
): Promise<number> {
  const inline = item.contentText?.length ?? 0;
  const blob = item.storageId ? await storedBlobSize(ctx, item.storageId) : 0;
  return inline + blob;
}

// Counted bytes of an EXISTING artifact row about to be deleted. Must run
// BEFORE ctx.storage.delete(row.storageId) — the system row goes with the
// blob. Chunk text is credited separately by whichever path deletes the
// chunk rows (they are not readable from the artifact row alone).
export async function measureArtifactRow(
  ctx: MutationCtx,
  row: Doc<"artifacts">,
): Promise<number> {
  const inline = row.contentText?.length ?? 0;
  let blob = 0;
  if (row.storageId) {
    const meta = await ctx.db.system.get(row.storageId);
    // Absent metadata means the blob is already gone; nothing left to credit.
    blob = meta?.size ?? 0;
  }
  return inline + blob;
}

async function runLedger(
  ctx: MutationCtx,
  runId: Id<"runs">,
): Promise<Doc<"runUsage"> | null> {
  return await ctx.db
    .query("runUsage")
    .withIndex("by_run", (q) => q.eq("runId", runId))
    .unique();
}

async function orgLedger(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
): Promise<Doc<"orgUsage"> | null> {
  return await ctx.db
    .query("orgUsage")
    .withIndex("by_org", (q) => q.eq("organizationId", organizationId))
    .unique();
}

// The org a run's artifacts are charged to, or undefined for pre-auth /
// single-user data (experiments without an organizationId). Per-artifact and
// per-run caps still apply then; the org quota cannot, having no org.
async function orgOfRunOrNone(
  ctx: MutationCtx,
  runId: Id<"runs">,
): Promise<Id<"organizations"> | undefined> {
  const run = await ctx.db.get(runId);
  if (!run) throw new Error("run not found");
  const exp = await ctx.db.get(run.experimentId);
  if (!exp) throw new Error("experiment not found");
  return exp.organizationId;
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${n} bytes`;
}

// chargeArtifacts enforces every cap and, only if all pass, records the
// charge. Call it BEFORE inserting the rows; throwing here aborts the whole
// mutation, so a rejected batch writes nothing. `perItem` carries each item's
// counted size (measureArtifactItem) — checked against the per-artifact cap
// individually, summed for the run/org ledgers.
export async function chargeArtifacts(
  ctx: MutationCtx,
  runId: Id<"runs">,
  perItem: { name: string; bytes: number }[],
): Promise<void> {
  const limits = artifactLimits();
  for (const it of perItem) {
    if (it.bytes > limits.maxArtifactBytes) {
      throw new Error(
        `artifact "${it.name}" is ${formatBytes(it.bytes)}, over the ` +
          `per-artifact cap of ${formatBytes(limits.maxArtifactBytes)} ` +
          `(DFTSTREAM_MAX_ARTIFACT_BYTES)`,
      );
    }
  }
  const deltaBytes = perItem.reduce((s, it) => s + it.bytes, 0);
  const deltaCount = perItem.length;

  const ledger = await runLedger(ctx, runId);
  const newCount = (ledger?.artifactCount ?? 0) + deltaCount;
  if (newCount > limits.maxRunArtifacts) {
    throw new Error(
      `run already has ${ledger?.artifactCount ?? 0} artifacts; adding ` +
        `${deltaCount} would exceed the per-run cap of ` +
        `${limits.maxRunArtifacts} (DFTSTREAM_MAX_RUN_ARTIFACTS)`,
    );
  }

  const organizationId = ledger?.organizationId ?? (await orgOfRunOrNone(ctx, runId));
  if (organizationId) {
    const org = await orgLedger(ctx, organizationId);
    const newOrgBytes = (org?.artifactBytes ?? 0) + deltaBytes;
    if (newOrgBytes > limits.orgQuotaBytes) {
      throw new Error(
        `organization artifact storage quota exceeded: ` +
          `${formatBytes(org?.artifactBytes ?? 0)} used + ` +
          `${formatBytes(deltaBytes)} requested > ` +
          `${formatBytes(limits.orgQuotaBytes)} ` +
          `(DFTSTREAM_ORG_STORAGE_QUOTA_BYTES). Delete old runs or raise ` +
          `the quota.`,
      );
    }
    if (org) {
      await ctx.db.patch(org._id, { artifactBytes: newOrgBytes });
    } else {
      await ctx.db.insert("orgUsage", { organizationId, artifactBytes: newOrgBytes });
    }
  }

  if (ledger) {
    await ctx.db.patch(ledger._id, {
      artifactBytes: ledger.artifactBytes + deltaBytes,
      artifactCount: newCount,
      // Backfill the org onto ledgers created before the run's experiment was
      // claimed by an org (importUnassignedNow) so later settles reach it.
      ...(ledger.organizationId === undefined && organizationId !== undefined
        ? { organizationId }
        : {}),
    });
  } else {
    await ctx.db.insert("runUsage", {
      runId,
      organizationId,
      artifactBytes: deltaBytes,
      artifactCount: deltaCount,
    });
  }
}

// chargeChunkText charges legacy chunk-append bytes (artifacts.appendChunk):
// no new artifact row, so only the byte ledgers move and only the org quota
// can reject. Kept separate from chargeArtifacts so the row count stays an
// exact count of artifact rows.
export async function chargeChunkText(
  ctx: MutationCtx,
  runId: Id<"runs">,
  bytes: number,
): Promise<void> {
  const limits = artifactLimits();
  const ledger = await runLedger(ctx, runId);
  const organizationId =
    ledger?.organizationId ?? (await orgOfRunOrNone(ctx, runId));
  if (organizationId) {
    const org = await orgLedger(ctx, organizationId);
    const newOrgBytes = (org?.artifactBytes ?? 0) + bytes;
    if (newOrgBytes > limits.orgQuotaBytes) {
      throw new Error(
        `organization artifact storage quota exceeded ` +
          `(DFTSTREAM_ORG_STORAGE_QUOTA_BYTES)`,
      );
    }
    if (org) {
      await ctx.db.patch(org._id, { artifactBytes: newOrgBytes });
    } else {
      await ctx.db.insert("orgUsage", { organizationId, artifactBytes: newOrgBytes });
    }
  }
  if (ledger) {
    await ctx.db.patch(ledger._id, {
      artifactBytes: ledger.artifactBytes + bytes,
    });
  } else {
    await ctx.db.insert("runUsage", {
      runId,
      organizationId,
      artifactBytes: bytes,
      artifactCount: 0,
    });
  }
}

// creditArtifacts takes bytes/rows back out of both ledgers, clamped at zero
// (rows written before accounting existed were never charged). Chunk-text
// credits pass rows = 0.
export async function creditArtifacts(
  ctx: MutationCtx,
  runId: Id<"runs">,
  bytes: number,
  rows: number,
): Promise<void> {
  const ledger = await runLedger(ctx, runId);
  if (!ledger) return; // never charged (legacy run) — nothing to credit
  const creditBytes = Math.min(bytes, ledger.artifactBytes);
  await ctx.db.patch(ledger._id, {
    artifactBytes: ledger.artifactBytes - creditBytes,
    artifactCount: Math.max(0, ledger.artifactCount - rows),
  });
  if (ledger.organizationId) {
    const org = await orgLedger(ctx, ledger.organizationId);
    if (org) {
      await ctx.db.patch(org._id, {
        artifactBytes: Math.max(0, org.artifactBytes - creditBytes),
      });
    }
  }
}

// settleRunUsage releases a run's ENTIRE counted usage and deletes its ledger
// row. Call it in the same transaction that deletes the run row (single-run
// delete and the experiment cascade's phase 1) — the children drain later,
// but the org's quota headroom comes back immediately and correctly, without
// the drain having to know about accounting at all.
export async function settleRunUsage(
  ctx: MutationCtx,
  runId: Id<"runs">,
): Promise<void> {
  const ledger = await runLedger(ctx, runId);
  if (!ledger) return;
  if (ledger.organizationId) {
    const org = await orgLedger(ctx, ledger.organizationId);
    if (org) {
      await ctx.db.patch(org._id, {
        artifactBytes: Math.max(0, org.artifactBytes - ledger.artifactBytes),
      });
    }
  }
  await ctx.db.delete(ledger._id);
}
