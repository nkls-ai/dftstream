// Convex-backed implementation of DataSource. Wraps each method around
// useQuery(api.<module>.<func>). Reactive subscriptions are free.
//
// This is the ONLY file in the UI (besides bootstrap) that imports from
// @db/api at runtime (data/normalize.ts imports its types only). All React
// components consume `useDataSource()`.

import { usePaginatedQuery, useQuery } from "convex/react";
import type { ConvexReactClient } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useMemo, useState } from "react";
import { api } from "@db/api";
import type { Id } from "@db/dataModel";
import { prepareArtifactUpload } from "../lib/artifactUpload";
import { fetchArtifactText } from "../lib/streamArtifact";
import { useStreamedText } from "./useArtifactTextStream";
import {
  normalizeBatch,
  normalizeBatchProgress,
  normalizeBatchRunRow,
  normalizeExperimentSummary,
  normalizeInputTemplate,
  normalizePathway,
  normalizeQueuedJob,
  normalizeRun,
} from "./normalize";
import type { AccountInfo, AddMemberResult, ArtifactUploadResult, CliSessionInfo, CubeMeta, DataSource, ExcitedStateRow, InputTemplate, InputTemplateInput, MachineTokenInfo, NMRShieldRow, OrgMember, OrgMembership, OrgRole, PaginatedQueryResult, QueuedJob, RunThermoPatch, VibBlob } from "./DataSource";
import type { BatchRunLike } from "../lib/batchStats";
import type {
  Artifact,
  ArtifactContent,
  ArtifactTextStream,
  Batch,
  BatchProgress,
  CappedQueryResult,
  Experiment,
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

type ArtifactRow = FunctionReturnType<typeof api.artifacts.listForRun>[number];
type CubeRow = FunctionReturnType<typeof api.artifacts.cubeIndex>[number];
type VibRow = FunctionReturnType<
  typeof api.artifacts.getVibModesForRun
>[number];

function wrap<T>(value: T | undefined): QueryResult<T> {
  return { data: value, loading: value === undefined };
}

// Per-run time series (hardware samples, SCF/opt metrics) are paged on the
// backend so no single query return exceeds Convex's 8192-element array cap or
// its per-query document-scan limit. The hooks below stream every page and
// reassemble the full, lossless series, so a long run's chart shows all of its
// data — it just fills in progressively as pages arrive.
const SERIES_PAGE_SIZE = 2000;

// Mirrors the .take() in db/convex/runs.ts:listByExperiment. That query returns
// the newest N runs and gives no indication that it truncated, so the cap has
// to be restated here to detect it.
export const RUNS_BY_EXPERIMENT_CAP = 1000;

type ContentRow = FunctionReturnType<typeof api.artifacts.getContent>;

// rewriteStorageHost repoints a server-issued storage URL (signed download
// link or upload target) at the host the browser actually reaches Convex on.
// A self-hosted backend builds these URLs from its own configured origin,
// often http://127.0.0.1:PORT, which is unreachable from a remote browser; the
// storage endpoints live on the same backend, so swap in the known origin and
// keep the path + token query. Returns the input unchanged if it can't parse.
function rewriteStorageHost(raw: string, base: string | undefined): string {
  if (!base) return raw;
  try {
    const u = new URL(raw);
    const b = new URL(base);
    u.protocol = b.protocol;
    u.host = b.host;
    return u.toString();
  } catch {
    /* not an absolute URL we can rewrite — use it as-is */
    return raw;
  }
}

// Hostnames that mean "this machine" from the backend's own point of view. A
// self-hosted backend builds its site origin (CONVEX_SITE_URL) from its local
// config, typically http://127.0.0.1:3211 — unreachable from a remote
// browser. Only these get repointed; a real hostname (cloud .convex.site, a
// LAN name) is already the right place to go.
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "0.0.0.0", "[::1]"]);

// rewriteBodyUrlHost repoints a backend-issued /api/artifact URL at the host
// the browser actually reaches Convex on, KEEPING the URL's own port: the
// authenticated body route lives on the deployment's site origin (locally
// port 3211), not the query origin (3210), so unlike rewriteStorageHost only
// the hostname/protocol may be borrowed from convexUrl. Returns the input
// unchanged for non-loopback hosts or anything unparsable.
function rewriteBodyUrlHost(raw: string, base: string | undefined): string {
  if (!base) return raw;
  try {
    const u = new URL(raw);
    if (!LOOPBACK_HOSTNAMES.has(u.hostname)) return raw;
    const b = new URL(base);
    u.protocol = b.protocol;
    u.hostname = b.hostname;
    return u.toString();
  } catch {
    /* not an absolute URL we can rewrite — use it as-is */
    return raw;
  }
}

// deriveContentSource normalizes a getContent result into the inputs the
// streaming/content hooks need: the authenticated body URL (storage-backed
// rows — the fetch attaches the caller's JWT, see lib/streamArtifact.ts), the
// stream cache key (the artifactId: bodyUrl is derived from it and the bytes
// behind an artifact id never change), how the blob is encoded, the inline
// body, and whether the query is still resolving.
//
// The encoding is passed through verbatim rather than validated here: this
// runs during render, and an unknown encoding must surface as a stream error
// (see resolveArtifactEncoding), not as a thrown render.
function deriveContentSource(
  artifactId: string | null,
  row: ContentRow | undefined,
  convexUrl: string | undefined,
): {
  url: string | null;
  key: string | null;
  encoding: string | null;
  inline: { text: string; truncated?: boolean; incomplete?: boolean } | null;
  resolving: boolean;
} {
  const resolving = artifactId != null && row === undefined;
  const obj = row && typeof row === "object" ? row : null;
  // A storage-backed row flagged incomplete means the blob vanished from
  // storage — there is nothing to download, so surface an empty incomplete
  // body instead of a doomed fetch.
  const vanished =
    obj != null && "bodyUrl" in obj && obj.incomplete === true;
  const rawUrl = obj && "bodyUrl" in obj && !vanished ? obj.bodyUrl ?? null : null;
  const url = rawUrl ? rewriteBodyUrlHost(rawUrl, convexUrl) : null;
  const key = url ? artifactId : null;
  const encoding = obj && "encoding" in obj ? obj.encoding ?? null : null;
  const inline =
    obj && "contentText" in obj
      ? {
          text: obj.contentText ?? "",
          truncated: obj.truncated,
          incomplete: "incomplete" in obj ? obj.incomplete : undefined,
        }
      : vanished
        ? { text: "", truncated: obj?.truncated, incomplete: true }
        : null;
  return { url, key, encoding, inline, resolving };
}

export class ConvexDataSource implements DataSource {
  // The reactive client is also used for fire-and-forget mutations
  // (rename / remove). Hooks like useMutation can't be called from
  // imperative event handlers cleanly, so we keep a direct handle.
  // convexUrl is the reachable origin the browser uses for queries/mutations.
  // Server-issued storage URLs (signed download links, upload targets) are
  // built from the backend's own configured origin — often http://127.0.0.1
  // for a self-hosted deployment — which the browser can't reach, so we
  // repoint them at this host. See rewriteStorageHost.
  constructor(
    private readonly client: ConvexReactClient,
    private readonly convexUrl?: string,
  ) {}

  // Guards kickStartupMigrations to once per page load.
  private migrationsKicked = false;

  kickStartupMigrations(): void {
    if (this.migrationsKicked) return;
    this.migrationsKicked = true;
    // Convert any legacy chunked artifacts to file storage. No-op when the
    // data is already in the new format.
    this.client.mutation(api.migrations.startIfNeeded, {}).catch((err) => {
      // Best-effort: a failed kick just leaves old chunked rows on the
      // (still-working) legacy read path until the next startup.
      console.error("chunk→storage migration kick failed", err);
    });
    // Build the batchProgress rollups for batches that filled up before they
    // existed. No-op once done.
    this.client
      .mutation(api.migrations.startBatchProgressBackfillIfNeeded, {})
      .catch((err) => {
        // Best-effort: a failed kick leaves those batches without a rollup,
        // which the dashboard reports explicitly instead of showing zeroes.
        console.error("batchProgress backfill kick failed", err);
      });
    // Build the experimentProgress rollups that the experiments index reads.
    // No-op once done.
    this.client
      .mutation(api.migrations.startExperimentProgressBackfillIfNeeded, {})
      .catch((err) => {
        // Best-effort: a failed kick leaves those experiments' cards reporting
        // their summary as still being counted, not as empty.
        console.error("experimentProgress backfill kick failed", err);
      });
  }

  async renameExperiment(id: string, name: string): Promise<void> {
    await this.client.mutation(api.experiments.rename, {
      experimentId: id as Id<"experiments">,
      name,
    });
  }
  async removeExperiment(id: string): Promise<void> {
    // experiments:remove pops the visible rows synchronously and hands
    // the heavy cascade to the Convex scheduler — the call returns as
    // soon as the experiment + its run rows are gone, while child
    // tables drain in the background without blocking other queries.
    await this.client.mutation(api.experiments.remove, {
      experimentId: id as Id<"experiments">,
    });
  }
  async createBatch(experimentId: string, name: string): Promise<string> {
    return await this.client.mutation(api.experiments.createBatch, {
      experimentId: experimentId as Id<"experiments">,
      name,
      artifactLevel: "io",
    });
  }
  async renameBatch(id: string, name: string): Promise<void> {
    await this.client.mutation(api.experiments.renameBatch, {
      batchId: id as Id<"batches">,
      name,
    });
  }
  async removeBatch(id: string): Promise<void> {
    await this.client.mutation(api.experiments.removeBatch, {
      batchId: id as Id<"batches">,
    });
  }
  async renameRun(id: string, name: string): Promise<void> {
    await this.client.mutation(api.runs.rename, {
      runId: id as Id<"runs">,
      name,
    });
  }
  async removeRun(id: string): Promise<void> {
    // Same trick for a single run — pop the row, schedule cleanup.
    await this.client.mutation(api.runs.remove, {
      runId: id as Id<"runs">,
    });
  }

  async setRunNotes(id: string, notes: string): Promise<void> {
    await this.client.mutation(api.runs.setNotes, {
      runId: id as Id<"runs">,
      notes,
    });
  }

  async setRunTags(id: string, tags: string[]): Promise<void> {
    await this.client.mutation(api.runs.setTags, {
      runId: id as Id<"runs">,
      tags,
    });
  }

  async setRunParent(id: string, parentRunId: string | null, edgeKind?: string): Promise<void> {
    await this.client.mutation(api.runs.setParent, {
      runId: id as Id<"runs">,
      parentRunId: parentRunId as Id<"runs"> | null,
      parentEdgeKind: edgeKind,
    });
  }

  async fetchRunOutputText(runId: string): Promise<string | null> {
    const artifacts = await this.client.query(api.artifacts.listForRun, {
      runId: runId as Id<"runs">,
    });
    const out =
      artifacts.find((a) => a.kind === "output") ??
      artifacts.find((a) => a.name.endsWith(".out"));
    if (!out || !out.hasContent) return null;
    const row = await this.client.query(api.artifacts.getContent, {
      artifactId: out._id,
    });
    const { url, encoding, inline } = deriveContentSource(out._id, row ?? undefined, this.convexUrl);
    if (inline) return inline.text;
    if (!url) return null;
    return await fetchArtifactText(url, { encoding });
  }

  async patchRunThermo(runId: string, patch: RunThermoPatch): Promise<void> {
    await this.client.mutation(api.runs.updateStatus, {
      runId: runId as Id<"runs">,
      ...patch,
    });
  }

  async uploadRunArtifacts(runId: string, files: File[]): Promise<ArtifactUploadResult[]> {
    const prepared = await Promise.all(files.map((file) => prepareArtifactUpload(file)));
    // Upload over-preview bodies to file storage first, then record the
    // storageId on each item. This bypasses the per-second document write
    // quota that the old chunked-write path tripped on large files.
    const uploadedBlobs: string[] = [];
    try {
      for (const p of prepared) {
        if (p.body === undefined) continue;
        const rawUploadUrl = await this.client.mutation(api.artifacts.generateUploadUrl, {});
        const uploadUrl = rewriteStorageHost(rawUploadUrl, this.convexUrl);
        const res = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: p.body,
        });
        if (!res.ok) {
          throw new Error(`Upload failed for ${p.item.name}: HTTP ${res.status}`);
        }
        const { storageId } = (await res.json()) as { storageId: string };
        p.item.storageId = storageId;
        uploadedBlobs.push(storageId);
      }
      const ids = await this.client.mutation(api.artifacts.appendToRun, {
        runId: runId as Id<"runs">,
        items: prepared.map(({ item }) => ({
          ...item,
          storageId: item.storageId as Id<"_storage"> | undefined,
        })),
      });
      if (ids.length !== prepared.length) {
        throw new Error(`Backend returned ${ids.length} artifact ids for ${prepared.length} uploads.`);
      }
      return prepared.map(({ item }, i) => ({
        id: ids[i]!,
        name: item.name,
        kind: item.kind,
        sizeBytes: item.sizeBytes,
        truncated: !!item.truncated,
        chunked: item.storageId !== undefined,
      }));
    } catch (err) {
      // No artifact row references these blobs yet (the append failed, or a
      // later body upload threw mid-batch) — delete them so they don't leak.
      await Promise.allSettled(
        uploadedBlobs.map((storageId) =>
          this.client.mutation(api.artifacts.deleteBlob, {
            storageId: storageId as Id<"_storage">,
          }),
        ),
      );
      throw err;
    }
  }

  async removeArtifact(artifactId: string): Promise<void> {
    await this.client.mutation(api.artifacts.remove, {
      artifactId: artifactId as Id<"artifacts">,
    });
  }

  useExperiments(organizationId?: string | "skip"): QueryResult<Experiment[]> {
    const rows = useQuery(
      api.experiments.list,
      organizationId === "skip"
        ? "skip"
        : organizationId
          ? { organizationId: organizationId as Id<"organizations"> }
          : {},
    );
    return useMemo(
      () =>
        wrap(
          rows?.map((r) => ({
            id: r._id,
            name: r.name,
            createdAt: r.createdAt,
          })),
        ),
      [rows],
    );
  }

  useExperimentsWithSummary(pageSize: 10 | 50 | 100, organizationId?: string | "skip") {
    const { results, status, loadMore } = usePaginatedQuery(
      api.experiments.listWithSummary,
      organizationId === "skip"
        ? "skip"
        : organizationId
          ? { organizationId: organizationId as Id<"organizations"> }
          : {},
      { initialNumItems: pageSize },
    );
    return useMemo(
      () => ({
        data:
          status === "LoadingFirstPage"
            ? undefined
            : results.map(normalizeExperimentSummary),
        loading: status === "LoadingFirstPage",
        canLoadMore: status === "CanLoadMore",
        loadingMore: status === "LoadingMore",
        loadMore: () => loadMore(pageSize),
      }),
      [loadMore, pageSize, results, status],
    );
  }

  useExperiment(id: string): QueryResult<Experiment> {
    const row = useQuery(api.experiments.get, { id: id as Id<"experiments"> });
    return useMemo(() => {
      if (row === undefined) return { data: undefined, loading: true };
      if (row === null) return { data: undefined, loading: false };
      return {
        data: { id: row._id, name: row.name, createdAt: row.createdAt },
        loading: false,
      };
    }, [row]);
  }

  useBatchesByExperiment(id: string): QueryResult<Batch[]> {
    const rows = useQuery(api.experiments.listBatches, {
      experimentId: id as Id<"experiments">,
    });
    return useMemo(() => wrap(rows?.map(normalizeBatch)), [rows]);
  }

  useBatch(id: string): QueryResult<Batch> {
    const row = useQuery(api.experiments.getBatch, { batchId: id as Id<"batches"> });
    return useMemo(() => {
      if (row === undefined) return { data: undefined, loading: true };
      if (row === null) return { data: undefined, loading: false };
      return { data: normalizeBatch(row), loading: false };
    }, [row]);
  }

  useBatchProgress(id: string): QueryResult<BatchProgress | null> {
    const row = useQuery(api.runs.batchProgress, { batchId: id as Id<"batches"> });
    return useMemo(() => {
      if (row === undefined) return { data: undefined, loading: true };
      return { data: row ? normalizeBatchProgress(row) : null, loading: false };
    }, [row]);
  }

  useBatchRuns(id: string, pageSize: number): PaginatedQueryResult<BatchRunLike> {
    const { results, status, loadMore } = usePaginatedQuery(
      api.runs.listByBatchPaged,
      { batchId: id as Id<"batches"> },
      { initialNumItems: pageSize },
    );
    return useMemo(
      () => ({
        data:
          status === "LoadingFirstPage"
            ? undefined
            : results.map(normalizeBatchRunRow),
        loading: status === "LoadingFirstPage",
        canLoadMore: status === "CanLoadMore",
        loadingMore: status === "LoadingMore",
        loadMore: () => loadMore(pageSize),
      }),
      [loadMore, pageSize, results, status],
    );
  }

  useRunsByExperiment(id: string): CappedQueryResult<Run[]> {
    // "skip" suspends the query (Convex convention) — used by callers
    // that only sometimes have an experiment in scope (command palette).
    const rows = useQuery(
      api.runs.listByExperiment,
      id === "skip" ? "skip" : { experimentId: id as Id<"experiments"> },
    );
    return useMemo(() => {
      const data = rows?.map(normalizeRun);
      return {
        ...wrap(data),
        // runs.listByExperiment ends in .take(RUNS_BY_EXPERIMENT_CAP) and says
        // nothing about it. A full page back is the only signal available that
        // older runs were dropped, so treat it as "there may be more" — every
        // consumer counting or referencing these rows has to disclose that.
        capped: data != null && data.length >= RUNS_BY_EXPERIMENT_CAP,
      };
    }, [rows]);
  }

  useRunChildren(id: string): QueryResult<Run[]> {
    const rows = useQuery(api.runs.listChildren, { runId: id as Id<"runs"> });
    return useMemo(() => wrap(rows?.map(normalizeRun)), [rows]);
  }

  useQueuedJobsByExperiment(experimentId: string): QueryResult<QueuedJob[]> {
    const rows = useQuery(api.queue.listByExperiment, {
      experimentId: experimentId as Id<"experiments">,
    });
    return useMemo(() => wrap(rows?.map(normalizeQueuedJob)), [rows]);
  }

  async requestCancelQueuedJob(id: string): Promise<void> {
    await this.client.mutation(api.queue.requestCancel, {
      id: id as Id<"queuedJobs">,
    });
  }

  useRun(id: string | "skip"): QueryResult<Run> {
    const row = useQuery(api.runs.get, id === "skip" ? "skip" : { runId: id as Id<"runs"> });
    return useMemo(() => {
      if (row === undefined) return { data: undefined, loading: true };
      if (row === null) return { data: undefined, loading: false };
      return { data: normalizeRun(row), loading: false };
    }, [row]);
  }

  useRunningRuns(organizationId?: string | "skip"): QueryResult<Run[]> {
    const rows = useQuery(
      api.runs.listRunning,
      organizationId === "skip"
        ? "skip"
        : organizationId
          ? { organizationId: organizationId as Id<"organizations"> }
          : {},
    );
    return useMemo(() => wrap(rows?.map(normalizeRun)), [rows]);
  }

  async fetchRun(id: string): Promise<Run | null> {
    const row = await this.client.query(api.runs.get, { runId: id as Id<"runs"> });
    return row ? normalizeRun(row) : null;
  }

  useRunEvents(id: string): QueryResult<RunEvent[]> {
    const rows = useQuery(api.events.listForRun, {
      runId: id as Id<"runs">,
    });
    return useMemo(
      () =>
        wrap(
          rows?.map((r) => ({
            id: r._id,
            seq: r.seq,
            ts: r.ts,
            kind: r.kind,
            payload: (r.payload ?? {}) as Record<string, unknown>,
          })),
        ),
      [rows],
    );
  }

  useRunLogs(id: string): QueryResult<RunLog[]> {
    const rows = useQuery(api.logs.listForRun, {
      runId: id as Id<"runs">,
    });
    return useMemo(
      () =>
        wrap(
          rows?.map((r) => ({
            id: r._id,
            ts: r.ts,
            level: r.level,
            message: r.message,
            fields: r.fields as Record<string, unknown> | undefined,
          })),
        ),
      [rows],
    );
  }

  useRunMetrics(id: string, key: string): QueryResult<MetricPoint[]> {
    const { results, status, loadMore } = usePaginatedQuery(
      api.metrics.byRunKey,
      { runId: id as Id<"runs">, key },
      { initialNumItems: SERIES_PAGE_SIZE },
    );
    // Keep pulling pages until the query is exhausted; see SERIES_PAGE_SIZE.
    useEffect(() => {
      if (status === "CanLoadMore") loadMore(SERIES_PAGE_SIZE);
    }, [status, loadMore]);
    return useMemo(
      () => ({
        data:
          status === "LoadingFirstPage"
            ? undefined
            : results.map((r) => ({
                ts: r.ts,
                cycle: r.cycle,
                iter: r.iter,
                value: r.value,
              })),
        loading: status === "LoadingFirstPage",
      }),
      [results, status],
    );
  }

  useRunGeometries(id: string): QueryResult<Geometry[]> {
    const rows = useQuery(api.geometries.listForRun, {
      runId: id as Id<"runs">,
    });
    return useMemo(
      () => wrap(rows?.map((r) => ({ cycle: r.cycle, ts: r.ts, xyz: r.xyz }))),
      [rows],
    );
  }

  useRunFrequencies(id: string): QueryResult<Frequency[]> {
    const rows = useQuery(api.frequencies.getForRun, {
      runId: id as Id<"runs">,
    });
    return useMemo(
      () =>
        wrap(
          rows?.map((r) => ({
            idx: r.idx,
            wavenumber: r.wavenumber,
            imaginary: r.imaginary,
            irIntensity: r.irIntensity,
            hessIdx: r.hessIdx,
          })),
        ),
      [rows],
    );
  }

  useRunSysSamples(id: string): QueryResult<SysSample[]> {
    const { results, status, loadMore } = usePaginatedQuery(
      api.sysSamples.forRun,
      { runId: id as Id<"runs"> },
      { initialNumItems: SERIES_PAGE_SIZE },
    );
    // Keep pulling pages until the query is exhausted; see SERIES_PAGE_SIZE.
    useEffect(() => {
      if (status === "CanLoadMore") loadMore(SERIES_PAGE_SIZE);
    }, [status, loadMore]);
    return useMemo(
      () => ({
        data:
          status === "LoadingFirstPage"
            ? undefined
            : results.map((r) => ({
                ts: r.ts,
                cpuPct: r.cpuPct,
                rssMb: r.rssMb,
                threads: r.threads,
              })),
        loading: status === "LoadingFirstPage",
      }),
      [results, status],
    );
  }

  useRunArtifacts(id: string | "skip"): QueryResult<Artifact[]> {
    const rows = useQuery(
      api.artifacts.listForRun,
      id === "skip" ? "skip" : { runId: id as Id<"runs"> },
    );
    return useMemo(
      () =>
        wrap(
          rows?.map((r: ArtifactRow) => ({
            id: r._id,
            name: r.name,
            path: r.path,
            kind: r.kind,
            sizeBytes: r.sizeBytes,
            mtime: r.mtime,
            truncated: r.truncated,
            chunked: r.chunked,
            hasContent: r.hasContent,
          })),
        ),
      [rows],
    );
  }

  useRunCubeIndex(id: string): QueryResult<CubeMeta[]> {
    const rows = useQuery(api.artifacts.cubeIndex, {
      runId: id as Id<"runs">,
    });
    return useMemo(
      () =>
        wrap(
          rows?.map((r: CubeRow) => ({
            id: r._id,
            createdAt: r._creationTime,
            name: r.name,
            sizeBytes: r.sizeBytes,
          })),
        ),
      [rows],
    );
  }

  useRunVibModes(id: string): QueryResult<VibBlob[]> {
    const rows = useQuery(api.artifacts.getVibModesForRun, {
      runId: id as Id<"runs">,
    });
    // Storage-backed vibmodes return an authenticated bodyUrl instead of
    // inline text; fetch those bodies here so consumers keep getting a ready
    // VibBlob.contentText. The common case (small inline vibs) skips this
    // entirely.
    //
    // Keyed by artifact _id (the bodyUrl is derived from it and stable). A
    // settled entry — success OR failure — records text ("" on failure) so
    // `pending` always clears; one bad blob can't wedge the whole run in a
    // permanent loading state, and each body is fetched independently so a
    // single failure doesn't drop its siblings.
    const [fetched, setFetched] = useState<Record<string, string>>({});
    useEffect(() => {
      if (!rows) return;
      const targets = rows
        .filter(
          (r: VibRow): r is VibRow & { bodyUrl: string } =>
            !!r.bodyUrl && fetched[r._id] === undefined,
        )
        .map((r) => ({
          key: r._id,
          url: rewriteBodyUrlHost(r.bodyUrl, this.convexUrl),
          encoding: r.encoding,
        }));
      if (targets.length === 0) return;
      let cancelled = false;
      // allSettled never rejects and each fetch below catches its own error
      // (settling with "" so `pending` clears) — nothing to await here.
      void Promise.allSettled(
        targets.map(async ({ key, url, encoding }) => {
          try {
            return [key, await fetchArtifactText(url, { encoding })] as const;
          } catch (err) {
            console.error("vibmode body fetch failed", err);
            return [key, ""] as const; // settle so pending clears
          }
        }),
      ).then((results) => {
        if (cancelled) return;
        setFetched((prev) => {
          const next = { ...prev };
          for (const r of results) {
            if (r.status === "fulfilled") next[r.value[0]] = r.value[1];
          }
          return next;
        });
      });
      return () => {
        cancelled = true;
      };
    }, [rows, fetched]);

    return useMemo(() => {
      if (!rows) return { data: undefined, loading: true };
      const pending = rows.some(
        (r: VibRow) => r.bodyUrl && fetched[r._id] === undefined,
      );
      const data = rows.map((r: VibRow) => ({
        id: r._id,
        name: r.name,
        contentText: r.bodyUrl ? fetched[r._id] ?? "" : r.contentText,
      }));
      return { data, loading: pending };
    }, [rows, fetched]);
  }

  useRunNMRShields(id: string): QueryResult<NMRShieldRow[]> {
    const rows = useQuery(api.nmrShields.listForRun, {
      runId: id as Id<"runs">,
    });
    return useMemo(
      () =>
        wrap(
          rows?.map((r) => ({
            id: r._id,
            atomIdx: r.atomIdx,
            element: r.element,
            isotropic: r.isotropic,
            anisotropy: r.anisotropy,
          })),
        ),
      [rows],
    );
  }

  useRunExcitedStates(id: string): QueryResult<ExcitedStateRow[]> {
    const rows = useQuery(api.excitedStates.listForRun, {
      runId: id as Id<"runs">,
    });
    return useMemo(
      () =>
        wrap(
          rows?.map((r) => ({
            id: r._id,
            idx: r.idx,
            energyEv: r.energyEv,
            wavelengthNm: r.wavelengthNm,
            oscStrength: r.oscStrength,
            transitions: r.transitions,
          })),
        ),
      [rows],
    );
  }

  // Progressive variant of useArtifactContent: resolves the artifact's storage
  // URL (or inline body) and streams it so a multi-MB file renders as it
  // downloads instead of blocking on the full body.
  useArtifactTextStream(artifactId: string | null): ArtifactTextStream {
    const row = useQuery(
      api.artifacts.getContent,
      artifactId ? { artifactId: artifactId as Id<"artifacts"> } : "skip",
    );
    const { url, key, encoding, inline, resolving } = deriveContentSource(artifactId, row, this.convexUrl);
    return useStreamedText(url, key, encoding, inline, resolving);
  }

  // Like useArtifactTextStream but optimized for parse-only consumers: streams
  // to a single fullText (set on completion) without building a line array.
  useArtifactFullText(artifactId: string | null): ArtifactTextStream {
    const row = useQuery(
      api.artifacts.getContent,
      artifactId ? { artifactId: artifactId as Id<"artifacts"> } : "skip",
    );
    const { url, key, encoding, inline, resolving } = deriveContentSource(artifactId, row, this.convexUrl);
    return useStreamedText(url, key, encoding, inline, resolving, { buildLines: false });
  }

  useArtifactContent(
    artifactId: string | null,
  ): QueryResult<ArtifactContent | null> {
    const row = useQuery(
      api.artifacts.getContent,
      artifactId ? { artifactId: artifactId as Id<"artifacts"> } : "skip",
    );
    // Storage-backed artifacts return an authenticated bodyUrl instead of
    // inline text; fetch it here so every consumer keeps reading a plain
    // contentText. Keyed on the artifactId: the bodyUrl is derived from it
    // and the bytes behind an artifact id never change, so no ref dance is
    // needed (unlike the signed URLs this replaced, which churned across
    // query recomputes).
    const bodyRow = row && typeof row === "object" && "bodyUrl" in row ? row : undefined;
    // The blob vanished from storage: nothing to fetch.
    const vanished = bodyRow?.incomplete === true;
    const bodyUrl =
      bodyRow?.bodyUrl && !vanished
        ? rewriteBodyUrlHost(bodyRow.bodyUrl, this.convexUrl)
        : undefined;
    const bodyEncoding = bodyRow?.encoding;
    const [fetched, setFetched] = useState<{
      key: string;
      text: string;
      error: boolean;
    } | null>(null);
    useEffect(() => {
      if (!artifactId || !bodyUrl) return;
      let cancelled = false;
      // fetchArtifactText applies the row's recorded encoding (identity for
      // everything written before compression existed) and attaches the
      // caller's JWT (lib/streamArtifact.ts).
      fetchArtifactText(bodyUrl, { encoding: bodyEncoding })
        .then((text) => {
          if (!cancelled) setFetched({ key: artifactId, text, error: false });
        })
        .catch((err: unknown) => {
          console.error("artifact content fetch failed", err);
          if (!cancelled) setFetched({ key: artifactId, text: "", error: true });
        });
      return () => {
        cancelled = true;
      };
    }, [artifactId, bodyUrl, bodyEncoding]);
    return useMemo(() => {
      if (!artifactId) return { data: null, loading: false };
      if (row === undefined) return { data: undefined, loading: true };
      if (row === null) return { data: null, loading: false };
      if ("bodyUrl" in row) {
        if (row.incomplete) {
          // blob no longer in storage
          return {
            data: { contentText: "", truncated: row.truncated, incomplete: true },
            loading: false,
          };
        }
        if (!fetched || fetched.key !== artifactId) {
          return { data: undefined, loading: true };
        }
        return {
          data: {
            contentText: fetched.text,
            truncated: row.truncated,
            incomplete: fetched.error || row.incomplete,
          },
          loading: false,
        };
      }
      return {
        data: {
          contentText: row.contentText,
          truncated: row.truncated,
          incomplete: "incomplete" in row ? row.incomplete : undefined,
        },
        loading: false,
      };
    }, [artifactId, row, fetched]);
  }
  usePathwaysByExperiment(experimentId: string): QueryResult<Pathway[]> {
    const rows = useQuery(api.pathways.list, {
      experimentId: experimentId as Id<"experiments">,
    });
    return useMemo(
      () => wrap(rows?.map(normalizePathway)),
      [rows],
    );
  }

  usePathway(id: string): QueryResult<Pathway> {
    const row = useQuery(api.pathways.get, {
      pathwayId: id as Id<"pathways">,
    });
    return useMemo(() => {
      if (row === undefined) return { data: undefined, loading: true };
      if (row === null) return { data: undefined, loading: false };
      return { data: normalizePathway(row), loading: false };
    }, [row]);
  }

  async createPathway(
    experimentId: string,
    name: string,
    points: PathwayPoint[],
  ): Promise<string> {
    const id = await this.client.mutation(api.pathways.create, {
      experimentId: experimentId as Id<"experiments">,
      name,
      points: points.map((p) => ({
        ...p,
        runId: p.runId as Id<"runs">,
      })),
    });
    return id;
  }

  async renamePathway(id: string, name: string): Promise<void> {
    await this.client.mutation(api.pathways.rename, {
      pathwayId: id as Id<"pathways">,
      name,
    });
  }

  async updatePathwayPoints(
    id: string,
    points: PathwayPoint[],
  ): Promise<void> {
    await this.client.mutation(api.pathways.updatePoints, {
      pathwayId: id as Id<"pathways">,
      points: points.map((p) => ({
        ...p,
        runId: p.runId as Id<"runs">,
      })),
    });
  }

  async removePathway(id: string): Promise<void> {
    await this.client.mutation(api.pathways.remove, {
      pathwayId: id as Id<"pathways">,
    });
  }

  // --- Input-builder templates ---

  useInputTemplates(organizationId?: string | "skip"): QueryResult<InputTemplate[]> {
    const rows = useQuery(
      api.templates.list,
      organizationId === "skip"
        ? "skip"
        : { organizationId: organizationId as Id<"organizations"> | undefined },
    );
    return useMemo(() => wrap(rows?.map(normalizeInputTemplate)), [rows]);
  }

  async createInputTemplate(
    input: InputTemplateInput,
    organizationId?: string,
  ): Promise<string> {
    return await this.client.mutation(api.templates.create, {
      ...input,
      organizationId: organizationId as Id<"organizations"> | undefined,
    });
  }

  async updateInputTemplate(id: string, input: InputTemplateInput): Promise<void> {
    await this.client.mutation(api.templates.update, {
      templateId: id as Id<"inputTemplates">,
      ...input,
    });
  }

  async removeInputTemplate(id: string): Promise<void> {
    await this.client.mutation(api.templates.remove, {
      templateId: id as Id<"inputTemplates">,
    });
  }

  // --- Org / auth ---

  async getBackendAuthRequired(): Promise<boolean | null> {
    // Read as unknown: a backend older than the field omits it entirely.
    const info: { authRequired?: unknown } = await this.client.query(api.meta.version, {});
    return typeof info.authRequired === "boolean" ? info.authRequired : null;
  }

  useMe(): QueryResult<AccountInfo | null> {
    const row = useQuery(api.users.me);
    return useMemo(() => {
      if (row === undefined) return { data: undefined, loading: true };
      return {
        data: row ? { id: row._id, email: row.email, name: row.name } : null,
        loading: false,
      };
    }, [row]);
  }

  useMyOrgs(): QueryResult<OrgMembership[]> {
    const rows = useQuery(api.organizations.myOrgs);
    return useMemo(
      () =>
        wrap(
          rows?.map((r) => ({
            organizationId: r.organizationId,
            name: r.name,
            slug: r.slug,
            role: r.role as OrgRole,
          })),
        ),
      [rows],
    );
  }

  useMyRole(organizationId: string | "skip"): QueryResult<OrgRole | null> {
    const row = useQuery(
      api.organizations.myRole,
      organizationId === "skip"
        ? "skip"
        : { organizationId: organizationId as Id<"organizations"> },
    );
    return useMemo(() => {
      if (row === undefined) return { data: undefined, loading: true };
      return { data: (row as OrgRole | null) ?? null, loading: false };
    }, [row]);
  }

  useOrgMembers(organizationId: string | "skip"): QueryResult<OrgMember[]> {
    const rows = useQuery(
      api.organizations.members,
      organizationId === "skip"
        ? "skip"
        : { organizationId: organizationId as Id<"organizations"> },
    );
    return useMemo(
      () =>
        wrap(
          rows?.map((r) => ({
            membershipId: r.membershipId,
            appUserId: r.appUserId,
            email: r.email,
            name: r.name,
            role: r.role as OrgRole,
          })),
        ),
      [rows],
    );
  }

  async ensureSelf(): Promise<void> {
    await this.client.mutation(api.users.ensureSelf, {});
  }

  async createOrg(name: string): Promise<{ organizationId: string; slug: string }> {
    return await this.client.mutation(api.organizations.create, { name });
  }

  async renameOrg(organizationId: string, name: string): Promise<void> {
    await this.client.mutation(api.organizations.rename, {
      organizationId: organizationId as Id<"organizations">,
      name,
    });
  }

  async removeOrg(organizationId: string): Promise<void> {
    await this.client.mutation(api.organizations.remove, {
      organizationId: organizationId as Id<"organizations">,
    });
  }

  async addOrgMember(
    organizationId: string,
    email: string,
    role: OrgRole,
    confirmUserId?: string,
  ): Promise<AddMemberResult> {
    const res = await this.client.mutation(api.organizations.addMember, {
      organizationId: organizationId as Id<"organizations">,
      email,
      role,
      confirmUserId: confirmUserId as Id<"appUsers"> | undefined,
    });
    switch (res.status) {
      case "added":
        return { status: "added" };
      case "invited":
        return { status: "invited" };
      case "needs-confirmation":
        return {
          status: "needs-confirmation",
          candidate: {
            userId: res.candidate.userId,
            email: res.candidate.email,
            name: res.candidate.name,
            accountCreatedAt: res.candidate.accountCreatedAt,
            lastSeenAt: res.candidate.lastSeenAt,
            invitePendingSince: res.candidate.invitePendingSince,
          },
        };
    }
  }

  async updateOrgMemberRole(membershipId: string, role: OrgRole): Promise<void> {
    await this.client.mutation(api.organizations.updateRole, {
      membershipId: membershipId as Id<"memberships">,
      role,
    });
  }

  async removeOrgMember(membershipId: string): Promise<void> {
    await this.client.mutation(api.organizations.removeMember, {
      membershipId: membershipId as Id<"memberships">,
    });
  }

  async approveCliLink(code: string, organizationId: string): Promise<void> {
    await this.client.mutation(api.cliLinks.approve, {
      code,
      organizationId: organizationId as Id<"organizations">,
    });
  }

  // --- Machine tokens (admin) + own CLI sessions ---

  useMachineTokens(organizationId: string | "skip"): QueryResult<MachineTokenInfo[]> {
    const rows = useQuery(
      api.machineTokens.list,
      organizationId === "skip"
        ? "skip"
        : { organizationId: organizationId as Id<"organizations"> },
    );
    return useMemo(
      () =>
        wrap(
          rows?.map((r) => ({
            tokenId: r.tokenId,
            name: r.name,
            createdAt: r.createdAt,
            lastUsedAt: r.lastUsedAt,
            revokedAt: r.revokedAt,
          })),
        ),
      [rows],
    );
  }

  async createMachineToken(
    organizationId: string,
    name: string,
  ): Promise<{ tokenId: string; name: string; token: string }> {
    return await this.client.mutation(api.machineTokens.create, {
      organizationId: organizationId as Id<"organizations">,
      name,
    });
  }

  async revokeMachineToken(tokenId: string): Promise<void> {
    await this.client.mutation(api.machineTokens.revoke, {
      tokenId: tokenId as Id<"machineTokens">,
    });
  }

  useMyCliSessions(): QueryResult<CliSessionInfo[]> {
    const rows = useQuery(api.cliLinks.listMine);
    return useMemo(
      () =>
        wrap(
          rows?.map((r) => ({
            linkId: r.linkId,
            organizationId: r.organizationId,
            createdAt: r.createdAt,
            lastUsedAt: r.lastUsedAt,
            expiresAt: r.expiresAt,
          })),
        ),
      [rows],
    );
  }

  async revokeCliSession(linkId: string): Promise<void> {
    await this.client.mutation(api.cliLinks.revoke, {
      linkId: linkId as Id<"cliLinks">,
    });
  }
}
