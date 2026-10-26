import type { RunStatus } from "../data/types";

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return (
    <span className={`badge ${status}`}>
      <span className="dot" /> {status}
    </span>
  );
}
