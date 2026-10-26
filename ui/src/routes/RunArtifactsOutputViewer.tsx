import { useCallback, useMemo, useRef, useState } from "react";
import { VirtualText, type VirtualTextHandle } from "../components/VirtualText";
import { orcaLineClassName, renderOrcaLine } from "../syntax/orca/orcaRender";
import { buildTree, findLandmarks } from "./artifactsLandmarks";
import { LandmarkRow, TreeBranch } from "./RunArtifactsLandmarkTree";
import { ResizableSplit } from "./runDetailUi";
import { useSettings } from "../lib/settings";

export function OutputViewer({ lines, loading }: { lines: string[]; loading: boolean }) {
  const [{ energyDecimals }] = useSettings();
  // Landmarks need the whole file, so only compute them once streaming
  // finishes — recomputing over a growing line array on every chunk would be
  // O(n²). The text still renders progressively via the lines below.
  const landmarks = useMemo(
    () => (loading ? [] : findLandmarks(lines, energyDecimals)),
    [lines, loading, energyDecimals],
  );
  const tree = useMemo(() => buildTree(landmarks), [landmarks]);
  const [query, setQuery] = useState("");
  const vtRef = useRef<VirtualTextHandle | null>(null);

  const jumpTo = useCallback((lineIdx: number) => {
    vtRef.current?.scrollToLine(lineIdx);
  }, []);

  const flat = useMemo(() => {
    if (!query) return null;
    const q = query.toLowerCase();
    return landmarks.filter((l) => l.label.toLowerCase().includes(q));
  }, [landmarks, query]);

  return (
    <ResizableSplit
      defaultLeftPct={20}
      minLeftPct={10}
      maxLeftPct={40}
      left={
        <div style={{ display: "grid", gap: 8, alignContent: "start" }}>
          <h4
            style={{
              margin: 0,
              fontSize: 12,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              color: "var(--text-dim)",
            }}
          >
            {loading ? "Jump to (…)" : `Jump to (${landmarks.length})`}
          </h4>
          <input aria-label="Filter sections"
            type="search"
            placeholder="Filter sections…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{
              background: "var(--bg-elev-2)",
              border: "1px solid var(--border)",
              color: "var(--text)",
              padding: "6px 8px",
              borderRadius: 6,
              fontSize: 12,
            }}
          />
          <div
            className="lm-tree"
            style={{ maxHeight: 510, overflow: "auto" }}
          >
            {landmarks.length === 0 ? (
              <div className="dim" style={{ fontSize: 12, padding: 6 }}>
                No sections detected.
              </div>
            ) : flat ? (
              flat.map((l, i) => (
                <LandmarkRow
                  key={`${l.lineIdx}-${i}`}
                  node={{ ...l, children: [], flags: {} }}
                  depth={0}
                  onJump={jumpTo}
                />
              ))
            ) : (
              tree.map((node) => (
                <TreeBranch
                  key={node.lineIdx}
                  node={node}
                  depth={0}
                  onJump={jumpTo}
                />
              ))
            )}
          </div>
        </div>
      }
      right={
        <VirtualText
          ref={vtRef}
          lines={lines}
          height={540}
          renderLine={(line) => renderOrcaLine(line, "output")}
          lineClassName={(line) => orcaLineClassName(line, "output")}
        />
      }
    />
  );
}
