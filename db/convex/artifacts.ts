import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import {
  chargeArtifacts,
  chargeChunkText,
  creditArtifacts,
  measureArtifactItem,
  measureArtifactRow,
} from "./lib/artifactQuota";
import {
  ARTIFACT_ENCODING,
  ARTIFACT_KIND,
  artifactFields,
} from "./schema";
import type { ArtifactEncoding } from "./schema";
import type { Id } from "./_generated/dataModel";
import { appendRunChildren } from "./lib/runChildren";
import {
  gateAnyMembership,
  gateArtifactRead,
  gateArtifactWrite,
  gateRunModify,
  gateRunRead,
  gateRunWrite,
} from "./authz";

// Same columns as the artifacts table minus runId (schema.ts is the single
// source of truth); the mutations below supply runId themselves.
const artifactItem = v.object(artifactFields);

// blobEncoding resolves a row's stored encoding for the wire. An absent field
// means the row predates compression (or came from a UI upload, which stores
// verbatim) — that is identity by definition, never a guess about the bytes.
// The column is a closed union, so anything present is already known-good.
function blobEncoding(encoding: ArtifactEncoding | undefined): ArtifactEncoding {
  return encoding ?? ARTIFACT_ENCODING.IDENTITY;
}

// A storageId arriving in an item is UNTRUSTED input: nothing about the id
// itself says who uploaded the blob, and file storage has no per-org ACL. A
// member of org B who has ever seen an org-A storageId (getContent used to
// hand them to every reader of a run — including someone later removed from
// that org, or demoted to viewer; today only the uploader ever sees one, but
// historically-leaked ids stay dangerous) could otherwise attach it to a run
// of their own and then:
//   - read it back through the artifact body route  → cross-tenant read
//   - drop it through remove / setAll / upsertForRun → cross-tenant destruction
// Refusing an id that any artifact row already owns closes both: an unattached
// blob is only known to the caller who just uploaded it, and the very next
// mutation binds it for good.
async function assertBlobsUnclaimed(
  ctx: MutationCtx,
  items: { storageId?: Id<"_storage"> }[],
): Promise<void> {
  for (const item of items) {
    const storageId = item.storageId;
    if (!storageId) continue;
    const owner = await ctx.db
      .query("artifacts")
      .withIndex("by_storage", (q) => q.eq("storageId", storageId))
      .first();
    if (owner) {
      throw new Error("storage blob is already attached to an artifact");
    }
  }
}

// generateUploadUrl hands out a short-lived URL the client POSTs a file
// body to. The POST response is { storageId }, which the caller then
// passes back in setAll/appendToRun. This path bypasses the per-second
// transactional write quota that chunked document writes hit.
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    // No run context here; the blob is bound to a run only when setAll/
    // appendToRun records its storageId (those are org-gated). Require the
    // caller to belong to at least one org rather than merely being signed in:
    // org creation is self-service, so "authenticated" is a bar anyone can
    // clear, and an upload URL spends deployment storage.
    await gateAnyMembership(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

// deleteBlob removes an orphaned storage blob. Callers upload a body before
// recording its storageId on an artifact row; if that follow-up mutation fails
// the blob would leak, so they call this to clean up. Idempotent — deleting an
// already-gone blob is a no-op.
export const deleteBlob = mutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }) => {
    await gateAnyMembership(ctx);
    // Orphans only: a blob referenced by an artifact row belongs to that run —
    // deleting it must go through artifacts.remove's org gate. Without this
    // check any signed-in caller holding a storageId (getContent hands them
    // out to run readers) could destroy another org's artifact body.
    const owner = await ctx.db
      .query("artifacts")
      .withIndex("by_storage", (q) => q.eq("storageId", storageId))
      .first();
    if (owner) throw new Error("blob is attached to an artifact");
    await ctx.storage.delete(storageId);
  },
});

// setAll replaces the artifact list for a run. Returns the inserted ids
// in the same order as the input array.
export const setAll = mutation({
  args: { runId: v.id("runs"), items: v.array(artifactItem) },
  handler: async (ctx, { runId, items }) => {
    await gateRunWrite(ctx, runId);
    const existing = await ctx.db
      .query("artifacts")
      .withIndex("by_run_name", (q) => q.eq("runId", runId))
      .collect();
    // The delete side stays custom (storage blobs + legacy chunks must go with
    // each row); the insert side shares the generic append helper. Freed bytes
    // are credited back to the run/org ledgers — measured BEFORE the blob
    // delete, which destroys the size metadata with the blob.
    let freedBytes = 0;
    for (const row of existing) {
      freedBytes += await measureArtifactRow(ctx, row);
      if (row.storageId) await ctx.storage.delete(row.storageId);
      const chunks = await ctx.db
        .query("artifactChunks")
        .withIndex("by_artifact_idx", (q) => q.eq("artifactId", row._id))
        .collect();
      for (const c of chunks) {
        freedBytes += c.text.length;
        await ctx.db.delete(c._id);
      }
      await ctx.db.delete(row._id);
    }
    await creditArtifacts(ctx, runId, freedBytes, existing.length);
    // After the deletes: a caller re-submitting a storageId this very run
    // already owned is legitimate, and its old row is gone by now.
    await assertBlobsUnclaimed(ctx, items);
    await chargeArtifacts(
      ctx,
      runId,
      await Promise.all(
        items.map(async (it) => ({
          name: it.name,
          bytes: await measureArtifactItem(ctx, it),
        })),
      ),
    );
    return await appendRunChildren(ctx, "artifacts", runId, items);
  },
});

// upsertForRun replaces artifacts by NAME: rows whose name matches an
// incoming item are deleted (with their blobs/chunks), everything else is
// left alone, then the items are appended. Lets the wrapper re-upload a
// growing NEB trajectory mid-run without touching the rest of the manifest.
export const upsertForRun = mutation({
  args: { runId: v.id("runs"), items: v.array(artifactItem) },
  handler: async (ctx, { runId, items }) => {
    await gateRunWrite(ctx, runId);
    const names = new Set(items.map((it) => it.name));
    const existing = await ctx.db
      .query("artifacts")
      .withIndex("by_run_name", (q) => q.eq("runId", runId))
      .collect();
    let freedBytes = 0;
    let freedRows = 0;
    for (const row of existing) {
      if (!names.has(row.name)) continue;
      // Measured before the blob delete — see setAll.
      freedBytes += await measureArtifactRow(ctx, row);
      freedRows += 1;
      if (row.storageId) await ctx.storage.delete(row.storageId);
      const chunks = await ctx.db
        .query("artifactChunks")
        .withIndex("by_artifact_idx", (q) => q.eq("artifactId", row._id))
        .collect();
      for (const c of chunks) {
        freedBytes += c.text.length;
        await ctx.db.delete(c._id);
      }
      await ctx.db.delete(row._id);
    }
    await creditArtifacts(ctx, runId, freedBytes, freedRows);
    await assertBlobsUnclaimed(ctx, items);
    await chargeArtifacts(
      ctx,
      runId,
      await Promise.all(
        items.map(async (it) => ({
          name: it.name,
          bytes: await measureArtifactItem(ctx, it),
        })),
      ),
    );
    return await appendRunChildren(ctx, "artifacts", runId, items);
  },
});

// appendToRun adds artifacts to a run without removing existing ones.
export const appendToRun = mutation({
  args: { runId: v.id("runs"), items: v.array(artifactItem) },
  handler: async (ctx, { runId, items }) => {
    await gateRunWrite(ctx, runId);
    await assertBlobsUnclaimed(ctx, items);
    await chargeArtifacts(
      ctx,
      runId,
      await Promise.all(
        items.map(async (it) => ({
          name: it.name,
          bytes: await measureArtifactItem(ctx, it),
        })),
      ),
    );
    return await appendRunChildren(ctx, "artifacts", runId, items);
  },
});

// appendChunk writes one chunk of body text for an artifact. Kept as a
// single-chunk call because each chunk can be several hundred KB and we
// want to stay well clear of the per-mutation payload limit.
export const appendChunk = mutation({
  args: {
    artifactId: v.id("artifacts"),
    idx: v.number(),
    text: v.string(),
  },
  handler: async (ctx, { artifactId, idx, text }) => {
    await gateArtifactWrite(ctx, artifactId);
    const row = await ctx.db.get(artifactId);
    if (!row) throw new Error("artifact not found");
    // Legacy write path (pre-storage wrappers): chunk text still spends
    // deployment storage, so it is charged against the org quota like any
    // other artifact bytes.
    await chargeChunkText(ctx, row.runId, text.length);
    await ctx.db.insert("artifactChunks", { artifactId, idx, text });
  },
});

export const remove = mutation({
  args: { artifactId: v.id("artifacts") },
  handler: async (ctx, { artifactId }) => {
    const row = await ctx.db.get(artifactId);
    if (!row) return;
    // own-or-admin, keyed on the owning run's creator.
    await gateRunModify(ctx, row.runId);
    // Measured before the blob delete (the size metadata dies with the blob);
    // chunk bytes are credited by the async cleanup steps as they drain.
    const freedBytes = await measureArtifactRow(ctx, row);
    if (row.storageId) await ctx.storage.delete(row.storageId);
    await ctx.db.delete(artifactId);
    await creditArtifacts(ctx, row.runId, freedBytes, 1);
    await ctx.scheduler.runAfter(0, internal.artifacts._cleanupArtifactChunksStep, {
      artifactId,
      runId: row.runId,
    });
  },
});

// ~512 KB per chunk row → 8 rows ≈ 4 MiB read per step, well under the 16 MiB
// per-mutation budget (same sizing as migrations.ts CHUNK_BATCH).
const CLEANUP_CHUNK_BATCH = 8;

export const _cleanupArtifactChunksStep = internalMutation({
  // runId is optional only because jobs scheduled before quota accounting
  // existed carry no runId; those chunks were never charged, so skipping the
  // credit for them is exact, not drift.
  args: { artifactId: v.id("artifacts"), runId: v.optional(v.id("runs")) },
  handler: async (ctx, { artifactId, runId }) => {
    const chunks = await ctx.db
      .query("artifactChunks")
      .withIndex("by_artifact_idx", (q) => q.eq("artifactId", artifactId))
      .take(CLEANUP_CHUNK_BATCH);
    let freedBytes = 0;
    for (const chunk of chunks) {
      freedBytes += chunk.text.length;
      await ctx.db.delete(chunk._id);
    }
    if (runId && freedBytes > 0) {
      await creditArtifacts(ctx, runId, freedBytes, 0);
    }
    if (chunks.length === CLEANUP_CHUNK_BATCH) {
      await ctx.scheduler.runAfter(50, internal.artifacts._cleanupArtifactChunksStep, {
        artifactId,
        runId,
      });
    }
  },
});

// listForRun returns artifact metadata only — no inline contentText,
// so opening a run with a 10-MB stdout doesn't flood the WebSocket.
// The UI calls getContent on the selected artifact to lazy-fetch.
export const listForRun = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    await gateRunRead(ctx, runId);
    const rows = await ctx.db
      .query("artifacts")
      .withIndex("by_run_name", (q) => q.eq("runId", runId))
      .collect();
    return rows.map((r) => ({
      _id: r._id,
      _creationTime: r._creationTime,
      runId: r.runId,
      name: r.name,
      path: r.path,
      kind: r.kind,
      sizeBytes: r.sizeBytes,
      mtime: r.mtime,
      truncated: r.truncated,
      chunked: r.chunked,
      hasContent:
        (r.contentText !== undefined && r.contentText.length > 0) ||
        r.chunked === true ||
        r.storageId !== undefined,
    }));
  },
});

// LEGACY_CHUNK_READ_CAP bounds how many ~512 KB chunks getContent will read
// in a single query. A query that scans more than ~16 MiB (or returns a body
// past the result-size limit) throws — which is exactly how opening a run with
// a large pre-storage artifact used to crash. 12 chunks ≈ 6 MiB stays well
// under both limits; anything past that is flagged incomplete. The startup
// migration (migrations.ts) converts these rows to file storage so the full
// body is served over a streaming URL instead.
const LEGACY_CHUNK_READ_CAP = 12;

// artifactBodyUrl builds the authenticated download URL for a storage-backed
// artifact body: the /api/artifact HTTP action on this deployment's site
// origin (see http.ts). The route re-runs the same membership gate as this
// query on EVERY request, which is the whole point — the URL grants nothing
// by itself, unlike the permanent signed storage URLs that used to be
// returned here (a departed member who had recorded one kept reading org
// data forever).
function artifactBodyUrl(artifactId: Id<"artifacts">): string {
  const site = process.env.CONVEX_SITE_URL;
  if (!site) {
    throw new Error(
      "CONVEX_SITE_URL is not configured on this deployment — artifact " +
        "bodies are served from its HTTP actions origin and cannot be " +
        "resolved without it",
    );
  }
  return `${site.replace(/\/+$/, "")}/api/artifact?id=${artifactId}`;
}

// getContent returns the body for one artifact. Storage-backed artifacts
// return `bodyUrl`, an authenticated HTTP route the client fetches with its
// own JWT (the body can be up to 128 MB, far past the 16 MiB per-query read
// budget — and a query cannot stream a blob). NEVER a raw storageId or a
// signed storage URL: signed URLs don't expire and storage has no per-org
// ACL, so either one in a query result is a permanent capability that
// outlives membership. Legacy chunked artifacts concatenate a bounded head
// of their chunks; inline-only artifacts return contentText.
export const getContent = query({
  args: { artifactId: v.id("artifacts") },
  handler: async (ctx, { artifactId }) => {
    const row = await ctx.db.get(artifactId);
    if (!row) return null;
    await gateArtifactRead(ctx, artifactId);
    if (row.storageId) {
      const blobMeta = await ctx.db.system.get(row.storageId);
      return {
        // Clients key their fetch caches on the artifactId they already
        // hold; this URL is stable per artifact and grants nothing without
        // the caller's own credentials.
        bodyUrl: artifactBodyUrl(artifactId),
        // The client MUST decode with this, not by sniffing the download.
        encoding: blobEncoding(row.encoding),
        // Transfer size of the blob (compressed, when encoded). Undefined on
        // rows written before it was recorded; the client falls back to the
        // response's Content-Length for progress.
        storageBytes: row.storageBytes,
        truncated: row.truncated ?? false,
        incomplete: blobMeta === null, // blob vanished from storage
      };
    }
    if (!row.chunked) {
      return {
        contentText: row.contentText ?? "",
        truncated: row.truncated ?? false,
      };
    }
    // Bounded read: never scan enough chunks to blow the query budget. take()
    // returns chunks in idx order (the by_artifact_idx index is [artifactId,
    // idx]); the sort is a cheap safety net over the small slice.
    const chunks = await ctx.db
      .query("artifactChunks")
      .withIndex("by_artifact_idx", (q) => q.eq("artifactId", artifactId))
      .take(LEGACY_CHUNK_READ_CAP);
    chunks.sort((a, b) => a.idx - b.idx);
    const parts: string[] = [];
    if (row.contentText) parts.push(row.contentText);
    for (const c of chunks) parts.push(c.text);
    const total = parts.reduce((s, p) => s + p.length, 0);
    const cappedRead = chunks.length === LEGACY_CHUNK_READ_CAP;
    const incomplete =
      cappedRead ||
      (row.numChunks !== undefined && chunks.length < row.numChunks) ||
      (row.numChunks === undefined && total < row.sizeBytes * 0.9);
    return {
      contentText: parts.join(""),
      truncated: (row.truncated ?? false) || incomplete,
      incomplete,
    };
  },
});

// cubeIndex returns metadata-only entries for every cube artifact tied
// to a run. The full body for each cube (typically ~900 KB) is fetched
// on demand via getContent — fetching them all at once trivially blows
// past Convex's 16 MiB per-query read budget once per-cycle cubes exist.
export const cubeIndex = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    await gateRunRead(ctx, runId);
    const rows = await ctx.db
      .query("artifacts")
      .withIndex("by_run_kind", (q) =>
        q.eq("runId", runId).eq("kind", ARTIFACT_KIND.CUBE),
      )
      .collect();
    return rows.map((r) => ({ _id: r._id, _creationTime: r._creationTime, name: r.name, sizeBytes: r.sizeBytes }));
  },
});

// getVibModesForRun returns all imaginary-mode displacement xyz files
// (kind = "vibmode"). Files are named <stem>.v<NNN>.xyz where NNN is the ORCA
// mode index. Small/legacy bodies come back inline as contentText; a
// storage-backed body returns a `bodyUrl` instead (a query can't read a
// blob — and must never hand out a storageId or signed URL, see getContent)
// and the client fetches it with its own credentials — see useRunVibModes.
export const getVibModesForRun = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    await gateRunRead(ctx, runId);
    const vibs = await ctx.db
      .query("artifacts")
      .withIndex("by_run_kind", (q) =>
        q.eq("runId", runId).eq("kind", ARTIFACT_KIND.VIBMODE),
      )
      .collect();
    const out: {
      _id: typeof vibs[number]["_id"];
      name: string;
      contentText: string;
      bodyUrl?: string;
      encoding?: ArtifactEncoding;
    }[] = [];
    for (const r of vibs) {
      if (r.storageId) {
        out.push({
          _id: r._id,
          name: r.name,
          contentText: r.contentText ?? "",
          bodyUrl: artifactBodyUrl(r._id),
          encoding: blobEncoding(r.encoding),
        });
        continue;
      }
      let body = r.contentText ?? "";
      if (r.chunked) {
        // Bounded read — vibmodes are small, but never scan past the budget.
        const chunks = await ctx.db
          .query("artifactChunks")
          .withIndex("by_artifact_idx", (q) => q.eq("artifactId", r._id))
          .take(LEGACY_CHUNK_READ_CAP);
        chunks.sort((a, b) => a.idx - b.idx);
        body = body + chunks.map((c) => c.text).join("");
      }
      out.push({ _id: r._id, name: r.name, contentText: body });
    }
    return out;
  },
});

// _bodyMeta backs the GET /api/artifact HTTP route (http.ts): resolve the id,
// run the SAME membership gate as getContent, and hand back what the action
// needs to stream the blob. Internal — the storageId it returns crosses only
// the server-side runQuery boundary, never a client wire. Takes the id as a
// plain string because it arrives from a URL, not a validated function arg;
// normalizeId keeps garbage out of ctx.db.get.
export const _bodyMeta = internalQuery({
  args: { artifactId: v.string() },
  handler: async (ctx, { artifactId }) => {
    const id = ctx.db.normalizeId("artifacts", artifactId);
    if (!id) return null;
    const row = await ctx.db.get(id);
    if (!row) return null;
    // Same gate as getContent; throws for non-members, which the HTTP route
    // maps to 403. Runs BEFORE revealing whether the row has a body at all.
    await gateArtifactRead(ctx, id);
    if (!row.storageId) return null;
    return {
      storageId: row.storageId,
      encoding: blobEncoding(row.encoding),
      name: row.name,
    };
  },
});

// --- storageId rotation ------------------------------------------------------
//
// Before bodyUrl existed, getContent returned permanent signed storage URLs;
// any client that ever fetched a body may still hold a URL that reads it
// forever. Deleting an artifact kills its URL, but for data that must stay,
// the only cure is rotating the blob: copy the bytes into a NEW storageId,
// point the row at it, delete the old blob — every previously-issued URL dies
// with it. Operator-run (deployment key required), resumable, byte-identical:
//
//   cd db && bunx convex run artifacts:rotateStorageIdsNow
//
// See docs/auth.md.

const ROTATE_PAGE_SIZE = 8;

export const rotateStorageIdsNow = internalAction({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }): Promise<void> => {
    const page: {
      rows: { artifactId: Id<"artifacts">; storageId: Id<"_storage"> }[];
      continueCursor: string;
      isDone: boolean;
    } = await ctx.runQuery(internal.artifacts._listStorageBackedPage, {
      cursor: cursor ?? null,
    });
    for (const { artifactId, storageId } of page.rows) {
      const blob = await ctx.storage.get(storageId);
      // Blob already gone: nothing to rotate, and the row's own read path
      // reports it incomplete. Skip rather than fail the whole sweep.
      if (!blob) continue;
      const newStorageId = await ctx.storage.store(blob);
      const swapped: boolean = await ctx.runMutation(
        internal.artifacts._swapRotatedBlob,
        { artifactId, oldStorageId: storageId, newStorageId },
      );
      if (!swapped) {
        // The row changed hands (deleted / re-uploaded) between the read and
        // the swap — drop our copy so it doesn't leak.
        await ctx.storage.delete(newStorageId);
      }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.artifacts.rotateStorageIdsNow, {
        cursor: page.continueCursor,
      });
    }
  },
});

export const _listStorageBackedPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query("artifacts")
      .paginate({ cursor, numItems: ROTATE_PAGE_SIZE });
    return {
      rows: page.page
        .filter(
          (r): r is typeof r & { storageId: Id<"_storage"> } =>
            r.storageId !== undefined,
        )
        .map((r) => ({ artifactId: r._id, storageId: r.storageId })),
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

// _swapRotatedBlob commits one rotation atomically: only if the row still
// points at the blob the action copied. Returns false (copy must be dropped)
// otherwise. Usage accounting is unchanged on success — the byte count is
// identical by construction.
export const _swapRotatedBlob = internalMutation({
  args: {
    artifactId: v.id("artifacts"),
    oldStorageId: v.id("_storage"),
    newStorageId: v.id("_storage"),
  },
  handler: async (ctx, { artifactId, oldStorageId, newStorageId }) => {
    const row = await ctx.db.get(artifactId);
    if (!row || row.storageId !== oldStorageId) return false;
    await ctx.db.patch(artifactId, { storageId: newStorageId });
    await ctx.storage.delete(oldStorageId);
    return true;
  },
});
