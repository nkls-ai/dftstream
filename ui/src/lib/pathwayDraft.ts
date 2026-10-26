import type { PathwayPoint, PointRole } from "../data/types";

/**
 * Pure operations on a pathway-builder draft (an ordered list of
 * stationary points). Every operation returns a new array with `order`
 * renumbered 0..n-1 so the persisted ordering can never drift.
 */

/** Role for a point inserted at `index`: the first point is the reactant. */
export function roleForInsert(index: number): PointRole {
  return index === 0 ? "reactant" : "intermediate";
}

function renumber(points: PathwayPoint[]): PathwayPoint[] {
  return points.map((p, i) => ({ ...p, order: i }));
}

/** Append a run as the new last point. */
export function appendPoint(draft: PathwayPoint[], runId: string): PathwayPoint[] {
  return [
    ...draft,
    { runId, role: roleForInsert(draft.length), order: draft.length },
  ];
}

/** Insert a run at position `at`, shifting later points right. */
export function insertPoint(
  draft: PathwayPoint[],
  runId: string,
  at: number,
): PathwayPoint[] {
  const next = [...draft];
  next.splice(at, 0, { runId, role: roleForInsert(at), order: 0 });
  return renumber(next);
}

/** Remove the point at `idx`. */
export function removePointAt(draft: PathwayPoint[], idx: number): PathwayPoint[] {
  return renumber(draft.filter((_, i) => i !== idx));
}

/** Move the point at `from` to position `to`. */
export function reorderPoints(
  draft: PathwayPoint[],
  from: number,
  to: number,
): PathwayPoint[] {
  if (from === to) return draft;
  const next = [...draft];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return renumber(next);
}

/** Change the role of the point at `idx`. */
export function setPointRole(
  draft: PathwayPoint[],
  idx: number,
  role: PointRole,
): PathwayPoint[] {
  return draft.map((p, i) => (i === idx ? { ...p, role } : p));
}
