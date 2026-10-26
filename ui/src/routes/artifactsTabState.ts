import { useCallback, useRef, useState, type Dispatch, type SetStateAction, type PointerEvent as ReactPointerEvent } from "react";
import { useAlert, useConfirm } from "../components/Confirm";
import { useDataSource } from "../data/DataSource";
import type { Artifact } from "../data/types";
import { usePointerDrag } from "../hooks/usePointerDrag";
import { userErrorMessage } from "../lib/errorReporting";
import { displayBasename } from "./runDetailArtifacts";

/**
 * Confirm-then-delete flow for run artifacts. Artifacts being removed are
 * tracked in `pendingArtifactRemove` so the list can hide them optimistically;
 * a failed delete restores the entry and surfaces the error.
 */
export function useArtifactDeletion({
  selectedId,
  setSelectedId,
}: {
  selectedId: string | null;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
}): {
  pendingArtifactRemove: Set<string>;
  deleteArtifact: (artifact: Artifact) => Promise<void>;
} {
  const ds = useDataSource();
  const confirm = useConfirm();
  const alert = useAlert();
  const [pendingArtifactRemove, setPendingArtifactRemove] = useState<Set<string>>(new Set());

  const deleteArtifact = useCallback(async (artifact: Artifact) => {
    const ok = await confirm({
      title: `Delete artifact "${displayBasename(artifact.name)}"?`,
      tone: "danger",
      confirmLabel: "Delete",
      message: "This removes the stored artifact and any chunks from DFTStream. The original host file is not touched.",
    });
    if (!ok) return;
    setPendingArtifactRemove((s) => new Set(s).add(artifact.id));
    if (selectedId === artifact.id) setSelectedId(null);
    try {
      await ds.removeArtifact(artifact.id);
    } catch (err) {
      setPendingArtifactRemove((s) => {
        const next = new Set(s);
        next.delete(artifact.id);
        return next;
      });
      await alert({
        title: "Delete artifact failed",
        tone: "danger",
        message: userErrorMessage(err, "delete artifact"),
      });
    }
  }, [alert, confirm, ds, selectedId, setSelectedId]);

  return { pendingArtifactRemove, deleteArtifact };
}

/**
 * Width/collapse state for the artifact file-list pane, with a pointer-drag
 * resize handle clamped to 140-400 px.
 */
export function useArtifactTreePane(): {
  treeWidth: number;
  collapsed: boolean;
  setCollapsed: Dispatch<SetStateAction<boolean>>;
  onPointerDown: (e: ReactPointerEvent) => void;
} {
  const [treeWidth, setTreeWidth] = useState(220);
  const [collapsed, setCollapsed] = useState(false);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  const onPointerDown = usePointerDrag({
    onStart: (e) => {
      dragRef.current = { startX: e.clientX, startW: treeWidth };
    },
    onMove: (ev) => {
      if (!dragRef.current) return;
      const w = dragRef.current.startW + (ev.clientX - dragRef.current.startX);
      setTreeWidth(Math.max(140, Math.min(400, w)));
    },
    onEnd: () => {
      dragRef.current = null;
    },
  });

  return { treeWidth, collapsed, setCollapsed, onPointerDown };
}
