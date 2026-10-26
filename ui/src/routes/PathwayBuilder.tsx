import { useMemo, useState } from "react";
import { POINT_ROLES, type Pathway, type PathwayPoint, type PointRole, type Run } from "../data/types";
import { RunStatusBadge } from "../components/RunStatusBadge";
import { useAlert } from "../components/Confirm";
import {
  appendPoint,
  insertPoint,
  removePointAt,
  reorderPoints,
  setPointRole,
} from "../lib/pathwayDraft";
import { ROLE_OPTION_LABELS } from "./pathwayRoles";
import { useEhFormatter } from "../lib/useEnergyFormat";
import { useGuardedAction } from "../hooks/useGuardedAction";

function onDragStartAvail(e: React.DragEvent, runId: string) {
  e.dataTransfer.setData("text/x-run-id", runId);
  e.dataTransfer.effectAllowed = "copy";
}

/** Drag-and-drop editor for the ordered list of pathway points. */
export function PathwayBuilder({
  pathway,
  runs,
  onSave,
  onCancel,
}: {
  pathway: Pathway;
  runs: Run[];
  onSave: (points: PathwayPoint[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<PathwayPoint[]>(() =>
    [...pathway.points].sort((a, b) => a.order - b.order),
  );
  const [saving, setSaving] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<number | null>(null);
  const alert = useAlert();
  const guard = useGuardedAction();
  const fmtEh = useEhFormatter();

  const draftRunIds = useMemo(() => new Set(draft.map((p) => p.runId)), [draft]);

  const available = useMemo(
    () =>
      runs
        .filter((r) => r.lastEnergy != null && !draftRunIds.has(r.id))
        .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
    [runs, draftRunIds],
  );

  const runById = useMemo(() => {
    const m = new Map<string, Run>();
    for (const r of runs) m.set(r.id, r);
    return m;
  }, [runs]);

  const addRun = (run: Run) => setDraft((d) => appendPoint(d, run.id));

  const handleSave = async () => {
    if (draft.length < 2) {
      await alert({ title: "Too few points", message: "A pathway needs at least 2 stationary points." });
      return;
    }
    setSaving(true);
    await guard("save pathway", () => onSave(draft));
    setSaving(false);
  };

  // --- drag to reorder within sequence ---
  const onDragStartSeq = (e: React.DragEvent, idx: number) => {
    e.dataTransfer.setData("text/x-seq-idx", String(idx));
    e.dataTransfer.effectAllowed = "move";
    setDragIdx(idx);
  };

  const onDragOverSeq = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect =
      e.dataTransfer.types.includes("text/x-run-id") ? "copy" : "move";
    setDropTarget(idx);
  };

  const onDropSeq = (e: React.DragEvent, toIdx: number) => {
    e.preventDefault();
    setDragIdx(null);
    setDropTarget(null);

    const runId = e.dataTransfer.getData("text/x-run-id");
    if (runId) {
      const run = available.find((r) => r.id === runId);
      if (run) setDraft((d) => insertPoint(d, run.id, toIdx));
      return;
    }

    const fromStr = e.dataTransfer.getData("text/x-seq-idx");
    if (fromStr !== "") {
      setDraft((d) => reorderPoints(d, Number(fromStr), toIdx));
    }
  };

  const onDragEnd = () => {
    setDragIdx(null);
    setDropTarget(null);
  };

  // drop zone at the end (append)
  const onDropEnd = (e: React.DragEvent) => {
    e.preventDefault();
    setDragIdx(null);
    setDropTarget(null);

    const runId = e.dataTransfer.getData("text/x-run-id");
    if (runId) {
      const run = available.find((r) => r.id === runId);
      if (run) addRun(run);
      return;
    }
    const fromStr = e.dataTransfer.getData("text/x-seq-idx");
    if (fromStr !== "") {
      setDraft((d) => reorderPoints(d, Number(fromStr), d.length - 1));
    }
  };

  return (
    <div className="pathway-builder">
      <div className="pathway-builder-available card">
        <h3>Available runs</h3>
        <p className="builder-hint">Click or drag runs to add them to the pathway</p>
        <div className="pathway-builder-list">
          {available.length === 0 && (
            <div className="empty-state" style={{ padding: 16 }}>
              No more finished runs with energy data.
            </div>
          )}
          {available.map((r) => (
            <div
              key={r.id}
              className="pathway-builder-run"
              draggable
              onDragStart={(e) => onDragStartAvail(e, r.id)}
              onClick={() => addRun(r)}
            >
              <div>
                <span className="pathway-builder-drag-handle">⠿</span>
                <span className="pathway-builder-run-name">{r.name ?? r.id.slice(0, 10)}</span>
                <RunStatusBadge status={r.status} />
              </div>
              <span className="mono muted" style={{ fontSize: 12 }}>
                {r.lastEnergy != null ? `${fmtEh(r.lastEnergy)} Eh` : "no energy"}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="pathway-builder-sequence card">
        <h3>Pathway sequence</h3>
        <p className="builder-hint">Drag to reorder</p>
        {draft.length === 0 && (
          <div
            className="pathway-builder-dropzone"
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
            onDrop={onDropEnd}
          >
            Drop runs here or click them on the left
          </div>
        )}
        {draft.map((pt, i) => {
          const run = runById.get(pt.runId);
          const isDragging = dragIdx === i;
          const isOver = dropTarget === i && dragIdx !== i;
          return (
            <div
              key={pt.runId}
              className={
                "pathway-builder-item" +
                (isDragging ? " dragging" : "") +
                (isOver ? " drop-over" : "")
              }
              draggable
              onDragStart={(e) => onDragStartSeq(e, i)}
              onDragOver={(e) => onDragOverSeq(e, i)}
              onDrop={(e) => onDropSeq(e, i)}
              onDragEnd={onDragEnd}
            >
              <span className="pathway-builder-drag-handle">⠿</span>
              <span className="pathway-builder-order">{i + 1}</span>
              <span className="pathway-builder-item-name">
                {run?.name ?? pt.runId.slice(0, 10)}
              </span>
              <select
                className="pathway-role-select"
                value={pt.role}
                onChange={(e) => setDraft((d) => setPointRole(d, i, e.target.value as PointRole))}
              >
                {POINT_ROLES.map((role) => (
                  <option key={role} value={role}>{ROLE_OPTION_LABELS[role]}</option>
                ))}
              </select>
              <button type="button"
                className="pathway-builder-btn danger"
                onClick={() => setDraft((d) => removePointAt(d, i))}
                title="Remove"
              >
                ×
              </button>
            </div>
          );
        })}
        {draft.length > 0 && (
          <div
            className="pathway-builder-drop-end"
            onDragOver={(e) => { e.preventDefault(); setDropTarget(draft.length); }}
            onDrop={onDropEnd}
            onDragLeave={() => setDropTarget(null)}
          />
        )}
        <div className="pathway-builder-footer">
          <button type="button" className="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button"
            className="button primary"
            onClick={handleSave}
            disabled={saving || draft.length < 2}
          >
            {saving ? "Saving…" : "Save pathway"}
          </button>
        </div>
      </div>
    </div>
  );
}
