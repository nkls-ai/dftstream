import { useState, type KeyboardEvent } from "react";
import type { LandmarkNode } from "./artifactsLandmarks";

export function TreeBranch({
  node,
  depth,
  onJump,
}: {
  node: LandmarkNode;
  depth: number;
  onJump: (n: number) => void;
}) {
  const defaultOpen =
    node.kind === "convergedOpt" || node.flags.convergedCycle === true;
  const [open, setOpen] = useState(defaultOpen);
  const hasChildren = node.children.length > 0;
  return (
    <>
      <LandmarkRow
        node={node}
        depth={depth}
        onJump={onJump}
        expandable={hasChildren}
        open={open}
        onToggle={() => setOpen((x) => !x)}
      />
      {open &&
        node.children.map((c) => (
          <TreeBranch
            key={c.lineIdx}
            node={c}
            depth={depth + 1}
            onJump={onJump}
          />
        ))}
    </>
  );
}

export function LandmarkRow({
  node,
  depth,
  onJump,
  expandable,
  open,
  onToggle,
}: {
  node: LandmarkNode;
  depth: number;
  onJump: (n: number) => void;
  expandable?: boolean;
  open?: boolean;
  onToggle?: () => void;
}) {
  const classes = [
    "lm-row",
    `lm-${node.kind}`,
    expandable ? "lm-expandable" : "",
    node.flags.convergedCycle ? "is-converged-cycle" : "",
    node.flags.finalConverged ? "is-final" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const handleClick = () => {
    if (expandable && onToggle) onToggle();
    onJump(node.lineIdx);
  };
  const handleKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleClick();
    }
  };

  return (
    <div
      className={classes}
      style={{ paddingLeft: depth * 12 + 4 }}
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKey}
      title={`Line ${node.lineIdx + 1}${expandable ? " · click to expand/collapse" : ""}`}
    >
      <span className="lm-toggle">
        {expandable ? (open ? "▾" : "▸") : ""}
      </span>
      <span className="lm-label">
        <span className="lm-line dim mono">L{node.lineIdx + 1}</span>
        <span className="lm-text">{node.label}</span>
        {node.flags.finalConverged && (
          <span className="lm-badge lm-badge-final">★ final</span>
        )}
        {node.flags.convergedCycle && node.kind === "optCycle" && (
          <span className="lm-badge lm-badge-converged">converged</span>
        )}
      </span>
    </div>
  );
}
