import { useMemo, useState } from "react";
import { SkeletonArtifactViewer } from "../components/Skeleton";
import { useDataSource } from "../data/DataSource";
import { formatBytes } from "../lib/bytes";
import { kindBadge } from "./artifactKind";
import { filterArtifacts, sortArtifacts, type ArtifactSortMode } from "./artifactListView";
import { useArtifactDeletion, useArtifactTreePane } from "./artifactsTabState";
import { ArtifactUploadPanel } from "./RunArtifactsUploadPanel";
import { ArtifactViewer } from "./RunArtifactsViewer";
import { displayBasename, pickOutArtifact } from "./runDetailArtifacts";
import { Section } from "./runDetailUi";

// The tree pane is narrow and resizable (140-400 px), so the filter/sort
// controls are styled inline rather than through the wider .table-toolbar.
const treeFieldStyle = {
  width: "100%",
  padding: "4px 6px",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text)",
  fontSize: 12,
} as const;

export function ArtifactsTab({ runId }: { runId: string }) {
  const ds = useDataSource();
  const arts = ds.useRunArtifacts(runId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<ArtifactSortMode>("kind");
  const { pendingArtifactRemove, deleteArtifact } = useArtifactDeletion({ selectedId, setSelectedId });

  const items = useMemo(
    () =>
      sortArtifacts(
        (arts.data ?? []).filter((a) => !pendingArtifactRemove.has(a.id)),
        "kind",
      ),
    [arts.data, pendingArtifactRemove],
  );

  // The rows the tree actually shows. Selection is resolved against the full
  // `items` list on purpose: filtering out the selected file must not change
  // (or crash) the viewer.
  const visible = useMemo(
    () => sortArtifacts(filterArtifacts(items, query), sortMode),
    [items, query, sortMode],
  );
  const filtered = query.trim() !== "";

  const defaultArtifact = useMemo(
    () => {
      const outId = pickOutArtifact(items);
      return (
        (outId ? items.find((a) => a.id === outId) : undefined) ??
        items.find((a) => a.hasContent) ??
        items[0]
      );
    },
    [items],
  );
  const selected = items.find((a) => a.id === selectedId) ?? defaultArtifact;

  const { treeWidth, collapsed, setCollapsed, onPointerDown } = useArtifactTreePane();

  if (arts.loading) return <SkeletonArtifactViewer />;

  return (
    <div className="tab-shell">
      <Section title="Artifacts" sub={`${items.length} files`}>
        <ArtifactUploadPanel runId={runId} />
        {items.length === 0 ? (
          <div className="artifact-empty-card">
            <div>
              <strong>No artifacts captured yet.</strong>
              <span> Upload an ORCA output, geometry, or cube file to attach it to this run.</span>
            </div>
          </div>
        ) : (
          <div className="art-split">
            {!collapsed && (
              <div className="art-tree" style={{ width: treeWidth }}>
                <div className="art-tree-head">
                  <span>
                    {filtered
                      ? `${visible.length} of ${items.length} files`
                      : `${items.length} files`}
                  </span>
                  <button
                    type="button"
                    className="art-collapse-btn"
                    onClick={() => setCollapsed(true)}
                    aria-label="Collapse file list"
                  >‹</button>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "0 8px 6px" }}>
                  <input
                    type="search"
                    placeholder="Filter files…"
                    aria-label="Filter artifact files"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    style={treeFieldStyle}
                  />
                  <select
                    aria-label="Sort artifact files"
                    value={sortMode}
                    onChange={(e) => setSortMode(e.target.value as ArtifactSortMode)}
                    style={treeFieldStyle}
                  >
                    <option value="kind">Kind</option>
                    <option value="name">Name A–Z</option>
                    <option value="size">Largest first</option>
                  </select>
                </div>
                {visible.length === 0 ? (
                  <div className="dim" style={{ padding: "8px", fontSize: 12 }}>
                    No files match.
                  </div>
                ) : (
                  <ul className="art-flat-list">
                    {visible.map((a) => (
                      <li
                        key={a.id}
                        className={"art-flat-item" + (a.id === selected?.id ? " active" : "")}
                        onClick={() => setSelectedId(a.id)}
                      >
                        <span className={`art-kind-badge status-${kindBadge(a.kind)}`}>{a.kind}</span>
                        <span className="art-flat-name" title={a.path || a.name}>{displayBasename(a.name)}</span>
                        <span className="art-flat-size mono dim">{formatBytes(a.sizeBytes)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {!collapsed && (
              <div className="art-drag" onPointerDown={onPointerDown} />
            )}
            <div className="art-viewer" style={{ flex: 1, minWidth: 0 }}>
              {collapsed && (
                <button
                  type="button"
                  className="art-expand-btn"
                  onClick={() => setCollapsed(false)}
                  aria-label="Show file list"
                >
                  ›
                </button>
              )}
              {selected ? (
                <ArtifactViewer artifact={selected} onDelete={deleteArtifact} />
              ) : (
                <div className="empty-state">Select an artifact.</div>
              )}
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}
