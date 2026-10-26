import { SkeletonPanel } from "../components/Skeleton";
import { VirtualText } from "../components/VirtualText";
import { useDataSource } from "../data/DataSource";
import type { Artifact } from "../data/types";
import { formatBytes } from "../lib/bytes";
import { orcaLineClassName, renderOrcaLine } from "../syntax/orca/orcaRender";
import { kindBadge } from "./artifactKind";
import { orcaSyntaxModeForArtifact } from "./artifactsSyntaxMode";
import { OutputViewer } from "./RunArtifactsOutputViewer";
import { displayBasename } from "./runDetailArtifacts";
import { CopyButton } from "./runDetailUi";
import { formatTimeSetting, useSettings } from "../lib/settings";

export function ArtifactViewer({ artifact, onDelete }: { artifact: Artifact; onDelete: (artifact: Artifact) => void }) {
  const ds = useDataSource();
  const [{ timeFormat }] = useSettings();
  const mode = orcaSyntaxModeForArtifact(artifact);
  const stream = ds.useArtifactTextStream(
    artifact.hasContent ? artifact.id : null,
  );
  const truncated = !!(stream.truncated ?? artifact.truncated);
  const incomplete = !!stream.incomplete;
  const hasFirstContent = stream.lines.length > 0;
  return (
    <>
      <div className="artifact-head">
        <h3>{artifact.name}</h3>
        <div className="artifact-head-meta">
          <span className={`badge ${kindBadge(artifact.kind)}`}>
            <span className="dot" /> {artifact.kind}
          </span>
          <span>{formatBytes(artifact.sizeBytes)}</span>
          <span>{formatTimeSetting(artifact.mtime, timeFormat)}</span>
          {artifact.chunked && <span>chunked</span>}
          <button
            type="button"
            className="artifact-delete-btn"
            onClick={() => onDelete(artifact)}
          >
            Delete
          </button>
        </div>
      </div>
      <div
        className="artifact-path-row"
        style={{ marginBottom: truncated ? 6 : 14 }}
      >
        <span className="dim mono" style={{ fontSize: 12, wordBreak: "break-all" }} title={artifact.path}>
          {displayBasename(artifact.path || artifact.name)}
        </span>
        <CopyButton text={artifact.path} title="Copy file path" />
      </div>
      {truncated && (
        <div className="artifact-truncated">
          {incomplete
            ? `⚠ incomplete — showing ~${formatBytes(stream.bytesLoaded)} of ${formatBytes(artifact.sizeBytes)} — the stored body is missing or partial. Re-import the run or upload the file manually to get the full content.`
            : `⚠ truncated — showing ~${formatBytes(stream.bytesLoaded)} of ${formatBytes(artifact.sizeBytes)} — file is larger than the 128 MB stored ceiling; full file remains on the host`}
        </div>
      )}
      {stream.loading && hasFirstContent && (
        <div className="dim mono" style={{ fontSize: 12, marginBottom: 6 }}>
          loading… {formatBytes(stream.bytesLoaded)}
          {stream.totalBytes ? ` / ${formatBytes(stream.totalBytes)}` : ""}
        </div>
      )}
      {!artifact.hasContent ? (
        <div className="empty-state">
          Binary or empty - content not stored. Find it on the host at{" "}
          <code>{artifact.path}</code>.
        </div>
      ) : stream.error ? (
        <div className="empty-state">
          Failed to load content. The stored file may be unavailable - try
          re-importing the run.
        </div>
      ) : stream.loading && !hasFirstContent ? (
        <SkeletonPanel rows={12} height={540} />
      ) : mode === "output" ? (
        <OutputViewer lines={stream.lines} loading={stream.loading} />
      ) : mode === "input" ? (
        <VirtualText
          lines={stream.lines}
          height={540}
          renderLine={(line) => renderOrcaLine(line, "input")}
          lineClassName={(line) => orcaLineClassName(line, "input")}
        />
      ) : mode === "xyz" ? (
        <VirtualText
          lines={stream.lines}
          height={540}
          renderLine={(line) => renderOrcaLine(line, "xyz")}
          lineClassName={(line) => orcaLineClassName(line, "xyz")}
        />
      ) : (
        <VirtualText lines={stream.lines} height={540} />
      )}
    </>
  );
}
