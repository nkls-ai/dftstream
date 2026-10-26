import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StructureViewer } from "./StructureViewer";
import { parseMultiXYZ } from "./xyz";

interface Props {
  /** Multi-frame XYZ text as produced by orca_pltvib. */
  xyzMulti: string;
  /** Optional override for default speed in ms/frame. */
  defaultSpeedMs?: number;
}

export function VibPlayer({ xyzMulti, defaultSpeedMs = 80 }: Props) {
  const frames = useMemo(() => parseMultiXYZ(xyzMulti), [xyzMulti]);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speedMs, setSpeedMs] = useState(defaultSpeedMs);
  const max = frames.length - 1;

  // rAF-based animation loop — avoids setInterval drift and aligns with display refresh.
  const dirRef = useRef(1);
  useEffect(() => {
    if (!playing || max < 1) return;
    let raf: number;
    let prev = 0;
    const step = (t: number) => {
      if (t - prev >= speedMs) {
        prev = t;
        setIdx((i) => {
          let n = i + dirRef.current;
          // Bounce AT the endpoints — the two turning points are the maximum-
          // displacement frames a chemist most wants to see. The old code
          // snapped to max-1 / 1, silently skipping frame 0 and frame max.
          if (n >= max) { dirRef.current = -1; n = max; }
          else if (n <= 0) { dirRef.current = 1; n = 0; }
          return n;
        });
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, max, speedMs]);

  const go = useCallback(
    (delta: number) => setIdx((i) => Math.max(0, Math.min(max, i + delta))),
    [max],
  );

  if (!frames.length) {
    return (
      <div className="empty-state">
        Vibrational mode file is empty or could not be parsed.
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <StructureViewer
        xyz={frames[0]!}
        trajectory={frames}
        frameIndex={Math.min(idx, max)}
      />
      <div className="playback">
        <div className="playback-left">
          <button type="button"
            className="pb-step"
            onClick={() => go(-1)}
            disabled={idx <= 0}
            title="Prev frame"
          >
            ◀
          </button>
          <button type="button"
            className={"pb-play" + (playing ? " playing" : "")}
            onClick={() => setPlaying((p) => !p)}
            disabled={max < 1}
            title={playing ? "Pause" : "Play"}
          >
            <span className="pb-play-icon">{playing ? "❚❚" : "▶"}</span>
            <span className="pb-play-label">
              {playing ? "Vibrating" : "Play"}
            </span>
          </button>
          <button type="button"
            className="pb-step"
            onClick={() => go(1)}
            disabled={idx >= max}
            title="Next frame"
          >
            ▶
          </button>
        </div>
        <input aria-label="Playback speed"
          type="range"
          className="pb-range"
          min={0}
          max={max}
          value={Math.min(idx, max)}
          onChange={(e) => {
            setPlaying(false);
            setIdx(Number(e.target.value));
          }}
        />
        <div className="playback-right">
          <select
            className="pb-speed"
            value={speedMs}
            onChange={(e) => setSpeedMs(Number(e.target.value))}
            title="Animation speed"
          >
            <option value={20}>4× fast</option>
            <option value={40}>2× fast</option>
            <option value={80}>1× normal</option>
            <option value={160}>½× slow</option>
            <option value={320}>¼× very slow</option>
          </select>
          <span className="mono pb-counter">
            frame {idx + 1} / {frames.length}
          </span>
        </div>
      </div>
    </div>
  );
}
