/**
 * Export menu state + PNG/video capture flows for the StructureViewer.
 * Owns the menu open/close, progress overlay state, and the camera-locked
 * frame sequencing; the viewer/model refs stay owned by the component.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import type { GLModel, GLViewer } from "3dmol";
import { useDismiss } from "../../hooks/useDismiss";
import { reportError } from "../../lib/errorReporting";
import {
  canvasToPngBlob,
  canRecordVideo,
  downloadBlob,
  pickVideoMime,
  recordVideo,
  type ExportProgress,
  type FrameSequence,
} from "../../lib/viewerExport";

interface Options {
  viewerRef: { current: GLViewer | null };
  modelRef: { current: GLModel | null };
  /** Current display frame (0-based) — read at capture time, so a ref. */
  frameIndexRef: { current: number };
  trajectory?: string[];
  spinning: boolean;
  /** Filename stem for exports. Defaults to "structure". */
  exportFileStem?: string;
  /** Per-frame labels parallel to `trajectory`, used to name the PNG. */
  frameLabels?: string[];
}

export interface ViewerExportApi {
  menuOpen: boolean;
  setMenuOpen: (update: boolean | ((open: boolean) => boolean)) => void;
  exporting: { label: string; fraction: number } | null;
  menuRef: { current: HTMLDivElement | null };
  hasTrajectory: boolean;
  videoSupported: boolean;
  videoExt: string;
  exportPng: () => Promise<void>;
  exportVideo: () => Promise<void>;
}

export function useViewerExport({
  viewerRef,
  modelRef,
  frameIndexRef,
  trajectory,
  spinning,
  exportFileStem,
  frameLabels,
}: Options): ViewerExportApi {
  const [menuOpen, setMenuOpen] = useState(false);
  const [exporting, setExporting] = useState<{ label: string; fraction: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const stem = exportFileStem && exportFileStem.trim() ? exportFileStem.trim() : "structure";
  const hasTrajectory = Boolean(trajectory && trajectory.length > 1);
  const { videoSupported, videoExt } = useMemo(() => {
    const supported = canRecordVideo();
    return { videoSupported: supported, videoExt: supported ? (pickVideoMime()?.ext ?? "webm") : "webm" };
  }, []);

  // Close the export menu on outside click / Escape.
  useDismiss(menuOpen, () => setMenuOpen(false), [menuRef]);

  // Build the frame sequence the animation exporters step through: the opt
  // trajectory when present, otherwise a 360° turntable of the single frame.
  // `lockView` (the camera matrix captured at export start) is re-applied
  // before every frame so the export keeps exactly the zoom/orientation the
  // user is looking at — setFrame must not be allowed to drift the camera.
  const buildSequence = useCallback(
    (lockView: number[] | null): FrameSequence => {
      const v = viewerRef.current!;
      const model = modelRef.current;
      if (hasTrajectory && model && trajectory) {
        const n = trajectory.length;
        return {
          count: n,
          seek: async (i) => {
            await model.setFrame(i);
            if (lockView) v.setView(lockView);
            v.render();
          },
        };
      }
      const STEPS = 72;
      return {
        count: STEPS,
        seek: (i) => {
          if (i > 0) v.rotate(360 / STEPS, "y");
          v.render();
        },
      };
    },
    [hasTrajectory, trajectory, viewerRef, modelRef],
  );

  const exportPng = useCallback(async () => {
    setMenuOpen(false);
    const v = viewerRef.current;
    if (!v) return;
    try {
      // Sync the WebGL drawing buffer to the current container size — 3Dmol
      // only does this on window resize, so after a split-pane drag the buffer
      // can be stale and the snapshot ends up framed for the old size.
      v.resize();
      v.render();
      const blob = await canvasToPngBlob(v.getCanvas());
      const lbl = frameLabels?.[frameIndexRef.current];
      downloadBlob(`${stem}${lbl ? `.${lbl}` : ""}.png`, blob);
    } catch (err) {
      reportError(err, { source: "structure-viewer", action: "export png" });
    }
  }, [stem, frameLabels, viewerRef, frameIndexRef]);

  const exportVideo = useCallback(async () => {
    setMenuOpen(false);
    const v = viewerRef.current;
    if (!v || exporting) return;
    const wasSpinning = spinning;
    setExporting({ label: "Recording video…", fraction: 0 });
    const onProgress = (p: ExportProgress) =>
      setExporting((s) => (s ? { ...s, fraction: p.fraction } : s));
    const animLabel = hasTrajectory ? "trajectory" : "spin";
    // Sync the WebGL drawing buffer to the current container size before we
    // read pixels — 3Dmol only resizes on window resize, so after a
    // split-pane drag the buffer is stale and the capture comes out framed
    // for the old size ("zoomed out") even though the on-screen (composited)
    // view looks right.
    v.spin?.(false);
    v.resize();
    v.render();
    // Snapshot the current camera so the trajectory export preserves the
    // user's exact zoom/orientation rather than re-fitting.
    const lockView = hasTrajectory ? (v.getView() as number[]) : null;
    try {
      const seq = buildSequence(lockView);
      const mime = pickVideoMime();
      if (!mime) throw new Error("This browser cannot record canvas video.");
      const blob = await recordVideo(v.getCanvas(), seq, mime, { fps: 5, onProgress });
      downloadBlob(`${stem}.${animLabel}.${mime.ext}`, blob);
    } catch (err) {
      reportError(err, { source: "structure-viewer", action: "export video" });
    } finally {
      // Restore the frame the user was viewing + their camera + spin pref.
      try {
        const model = modelRef.current;
        if (hasTrajectory && model) await model.setFrame(frameIndexRef.current);
        if (lockView) v.setView(lockView);
        v.render();
        if (wasSpinning) v.spin?.("y");
      } catch {
        // Best-effort restore — a failure here only affects the live view,
        // not the already-downloaded export.
      }
      setExporting(null);
    }
  }, [exporting, spinning, hasTrajectory, buildSequence, stem, viewerRef, modelRef, frameIndexRef]);

  return {
    menuOpen,
    setMenuOpen,
    exporting,
    menuRef,
    hasTrajectory,
    videoSupported,
    videoExt,
    exportPng,
    exportVideo,
  };
}
