import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { EnergyChart } from "../components/EnergyChart";
import { PlaybackBar } from "../components/PlaybackBar";
import { StructureViewer } from "../components/StructureViewer";
import { usePlayback } from "../hooks/usePlayback";
import { formatBytes } from "../lib/bytes";
import { Callout, Headline, HeadlineTile, ResizableSplit, Section } from "./runDetailUi";
import {
  buildToolsEnergySeries,
  isSupportedLocalFile,
  localFileUrl,
  parseLoadedTraj,
  LOCAL_FILE_EXTENSIONS,
  type LoadedTraj,
} from "./toolsLocalFile";
import { useEhFormatter } from "../lib/useEnergyFormat";

type ToolsSource =
  | { kind: "path"; path: string }
  | { kind: "file"; name: string };

interface ToolsFileMeta {
  size: number | null;
  lastModified: string | null; // HTTP Last-Modified header (path sources)
}

const FOLLOW_INTERVAL_MS = 3000;

/** Standalone visualizer: load any xyz/trajectory by absolute path on the
 *  machine running the dftstream binary (works through port forwarding),
 *  or drop a file from the local disk. */
export function ToolsPage() {
  const localFilesEnabled = window.__DFTSTREAM_LOCAL_FILES__ === true;

  const [pathInput, setPathInput] = useState("");
  const [source, setSource] = useState<ToolsSource | null>(null);
  const [traj, setTraj] = useState<LoadedTraj | null>(null);
  const [meta, setMeta] = useState<ToolsFileMeta>({ size: null, lastModified: null });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [relative, setRelative] = useState(true);
  const fmtEh = useEhFormatter();
  const [follow, setFollow] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const pb = usePlayback(traj?.frames.length ?? 0);
  const pbRef = useRef(pb);
  pbRef.current = pb;

  const applyText = useCallback((text: string, size: number | null, lastModified: string | null) => {
    const parsed = parseLoadedTraj(text);
    if (parsed.frames.length === 0) {
      setError("No XYZ frames found in the file. Expected xyz / multi-frame trajectory format.");
      return false;
    }
    // Keep tracking the newest frame when the user was already on it —
    // that's what makes live-follow feel live for a growing trajectory.
    const wasAtEnd = pbRef.current.atEnd;
    setTraj(parsed);
    setMeta({ size, lastModified });
    setError(null);
    if (wasAtEnd) pbRef.current.setIdx(parsed.frames.length - 1);
    return true;
  }, []);

  const loadFromPath = useCallback(async (path: string, opts?: { ifModifiedSince?: string | null; quiet?: boolean }) => {
    if (!opts?.quiet) setBusy(true);
    try {
      const headers: Record<string, string> = {};
      if (opts?.ifModifiedSince) headers["If-Modified-Since"] = opts.ifModifiedSince;
      const res = await fetch(localFileUrl(path), { headers, cache: "no-store" });
      if (res.status === 304) return true; // unchanged — keep current frames
      if (!res.ok) {
        setError(await res.text() || `Loading failed with HTTP ${res.status}.`);
        return false;
      }
      if ((res.headers.get("content-type") ?? "").includes("text/html")) {
        // A catch-all SPA fallback answered instead of the file endpoint.
        setError("This server does not expose /api/local-file — path loading requires the UI served by `dftstream ui`.");
        return false;
      }
      const ok = applyText(await res.text(), Number(res.headers.get("x-file-size")) || null, res.headers.get("last-modified"));
      if (ok) setSource({ kind: "path", path });
      return ok;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Loading failed.");
      return false;
    } finally {
      if (!opts?.quiet) setBusy(false);
    }
  }, [applyText]);

  const loadFromFile = useCallback(async (file: File) => {
    if (!isSupportedLocalFile(file.name)) {
      setError(`Unsupported file type. Use ${LOCAL_FILE_EXTENSIONS.join(", ")}.`);
      return;
    }
    setBusy(true);
    try {
      const ok = applyText(await file.text(), file.size, null);
      if (ok) {
        setSource({ kind: "file", name: file.name });
        setFollow(false); // no path to re-poll for dropped files
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reading the file failed.");
    } finally {
      setBusy(false);
    }
  }, [applyText]);

  // Live-follow: re-fetch a path source on an interval; 304s are free.
  useEffect(() => {
    if (!follow || source?.kind !== "path") return;
    const id = window.setInterval(() => {
      void loadFromPath(source.path, { ifModifiedSince: meta.lastModified, quiet: true }).then((ok) => {
        if (!ok) setFollow(false);
      });
    }, FOLLOW_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [follow, source, meta.lastModified, loadFromPath]);

  const handleDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void loadFromFile(file);
  }, [loadFromFile]);

  const frames = traj?.frames ?? [];
  const energySeries = traj ? buildToolsEnergySeries(traj.energies, relative) : [];
  const definedEnergies = traj?.energies.filter((e) => e != null).length ?? 0;
  const currentEnergy = traj?.energies[pb.idx];

  const viewer = frames.length > 0 && (
    <Section
      title="Structure"
      sub={
        <span>
          frame <span style={{ color: "var(--text)" }}>{pb.idx}</span> / {frames.length - 1}
          {currentEnergy != null && (
            <>
              {" · "}
              <span className="mono" style={{ color: "var(--text)" }}>{fmtEh(currentEnergy)}</span>{" "}
              <span style={{ color: "var(--text-faint)" }}>Eh</span>
            </>
          )}
        </span>
      }
    >
      <div className="card" style={{ padding: 12 }}>
        <StructureViewer
          xyz={frames[pb.idx] ?? ""}
          trajectory={frames.length > 1 ? frames : undefined}
          frameIndex={frames.length > 1 ? pb.idx : undefined}
        />
        {frames.length > 1 && <PlaybackBar pb={pb} label={(i) => `frame ${i}`} />}
      </div>
    </Section>
  );

  const chart = energySeries.length > 1 && (
    <Section
      title="Energy"
      sub={
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={relative}
            onChange={(e) => setRelative(e.target.checked)}
          />
          relative (kcal/mol)
        </label>
      }
    >
      <EnergyChart
        data={energySeries}
        xLabel="frame"
        yLabel={relative ? "ΔE (kcal/mol)" : "E (Eh)"}
        height={300}
        markerX={currentEnergy != null ? pb.idx : null}
        onClickPoint={(i) => {
          const frame = energySeries[i]?.x;
          if (frame != null) pb.setIdx(frame);
        }}
      />
    </Section>
  );

  return (
    <div className="tab-shell" style={{ padding: "20px 24px" }}>
      <h1 className="page-title">Tools</h1>

      <Section
        title="Visualize a structure or trajectory"
        sub={<span>xyz · trj · allxyz — conformer ensembles, optimizations, scans</span>}
      >
        <div style={{ display: "grid", gap: 10 }}>
          <form
            style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
            onSubmit={(e) => {
              e.preventDefault();
              const p = pathInput.trim();
              if (p) void loadFromPath(p);
            }}
          >
            <input
              type="text"
              className="mono"
              style={{ flex: "1 1 380px" }}
              placeholder="/absolute/path/on/the/dftstream/host/traj.xyz"
              aria-label="Absolute file path on the machine running dftstream"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              disabled={!localFilesEnabled}
            />
            <button type="submit" className="button" disabled={!localFilesEnabled || busy || pathInput.trim() === ""}>
              {busy ? "Loading…" : "Load"}
            </button>
            {source?.kind === "path" && (
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }} title="Re-read the file every few seconds — new frames appear as the job writes them">
                <input
                  type="checkbox"
                  checked={follow}
                  onChange={(e) => setFollow(e.target.checked)}
                />
                live-follow
              </label>
            )}
          </form>
          {!localFilesEnabled && (
            <div className="dim" style={{ fontSize: 13 }}>
              Path loading requires the UI served by <code>dftstream ui</code>{" "}
              (the binary reads the file from its own machine — works through
              port forwarding). Drag &amp; drop below works everywhere.
            </div>
          )}
          <div
            className={"artifact-upload" + (dragging ? " dragging" : "")}
            onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => { event.preventDefault(); setDragging(false); }}
            onDrop={handleDrop}
          >
            <div className="artifact-upload-mark">+</div>
            <div className="artifact-upload-copy">
              <strong>Drop an xyz / trajectory file</strong>
              <span>Read locally in your browser — nothing is uploaded or stored.</span>
            </div>
            <div className="artifact-upload-actions">
              <button
                type="button"
                className="dl-btn artifact-upload-btn"
                onClick={() => inputRef.current?.click()}
                disabled={busy}
              >
                Choose file
              </button>
              <input
                aria-label="Choose a structure or trajectory file"
                ref={inputRef}
                type="file"
                className="artifact-upload-input"
                accept={LOCAL_FILE_EXTENSIONS.join(",")}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file) void loadFromFile(file);
                  event.currentTarget.value = "";
                }}
              />
            </div>
          </div>
        </div>
      </Section>

      {error && (
        <Callout tone="bad" icon="✕">
          {error}
        </Callout>
      )}

      {traj && (
        <>
          <Headline>
            <HeadlineTile
              label="Source"
              value={<span style={{ fontSize: 14 }} className="mono">{source?.kind === "path" ? source.path.split("/").pop() : source?.name}</span>}
              sub={source?.kind === "path" ? source.path : "dropped file"}
            />
            <HeadlineTile label="Frames" value={frames.length} sub={follow ? "live-follow on" : undefined} tone={follow ? "accent" : undefined} />
            {definedEnergies > 0 && (
              <HeadlineTile label="Energies" value={definedEnergies} sub="from comment lines" />
            )}
            {meta.size != null && (
              <HeadlineTile label="Size" value={formatBytes(meta.size)} sub={meta.lastModified ?? undefined} />
            )}
          </Headline>

          {viewer && chart ? (
            <ResizableSplit defaultLeftPct={55} left={viewer} right={chart} />
          ) : (
            viewer
          )}
        </>
      )}
    </div>
  );
}
