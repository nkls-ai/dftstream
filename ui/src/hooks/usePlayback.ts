import { useCallback, useEffect, useRef, useState } from "react";

export interface Playback {
  idx: number;
  setIdx: (i: number | ((prev: number) => number)) => void;
  playing: boolean;
  setPlaying: (p: boolean | ((prev: boolean) => boolean)) => void;
  speedMs: number;
  setSpeedMs: (ms: number) => void;
  go: (delta: number) => void;
  max: number;
  atStart: boolean;
  atEnd: boolean;
}

// Whether a follow-mode playback keeps tracking the newest frame after the
// user moved to `nextIdx`: landing on the last frame re-attaches, anything
// else detaches, so scrubbing back never gets yanked forward by new data.
export function staysFollowing(nextIdx: number, max: number): boolean {
  return nextIdx >= max;
}

export interface PlaybackOptions {
  // Own the global arrow/Home/End/Space shortcuts (one playback per page).
  keys?: boolean;
  // Live data: while the user has not navigated away from the end, the
  // index tracks the last frame as `count` grows (a running optimization
  // shows its newest geometry). Turning it off (the run finished) leaves the
  // index where it is.
  follow?: boolean;
}

export function usePlayback(count: number, opts?: PlaybackOptions): Playback {
  const keys = opts?.keys ?? true;
  const follow = opts?.follow ?? false;
  const [rawIdx, setRawIdx] = useState(0);
  const [following, setFollowing] = useState(true);
  const [playing, setPlayingRaw] = useState(false);
  const [speedMs, setSpeedMs] = useState(600);
  const max = Math.max(0, count - 1);
  const tracking = follow && following && !playing;
  // Clamp during render instead of via an effect: when `count` shrinks below
  // the current index, the displayed index follows immediately (no one-frame
  // out-of-range flash, no extra render). The raw setter self-heals on the
  // next navigation since go()/step both re-clamp against `max`.
  const idx = tracking ? max : Math.min(rawIdx, max);

  const maxRef = useRef(max);
  maxRef.current = max;
  const idxRef = useRef(idx);
  idxRef.current = idx;

  // Keep the raw index on the last frame while tracking, so the index stays
  // put when follow switches off at the end of the run.
  useEffect(() => {
    if (tracking) setRawIdx(max);
  }, [tracking, max]);

  const setIdx = useCallback((i: number | ((prev: number) => number)) => {
    const m = maxRef.current;
    const next = Math.max(0, Math.min(m, typeof i === "function" ? i(idxRef.current) : i));
    setRawIdx(next);
    setFollowing(staysFollowing(next, m));
  }, []);

  const go = useCallback((delta: number) => setIdx((i) => i + delta), [setIdx]);

  // Starting playback is navigating: stopping it leaves the index where the
  // loop was instead of snapping back to the newest frame.
  const setPlaying = useCallback((p: boolean | ((prev: boolean) => boolean)) => {
    setPlayingRaw((prev) => {
      const next = typeof p === "function" ? p(prev) : p;
      if (next) setFollowing(false);
      return next;
    });
  }, []);

  const speedRef = useRef(speedMs);
  speedRef.current = speedMs;

  useEffect(() => {
    if (!playing || max < 1) return;
    let raf: number;
    let prev = 0;
    const step = (t: number) => {
      if (t - prev >= speedRef.current) {
        prev = t;
        setRawIdx((i) => (i >= maxRef.current ? 0 : i + 1));
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, max]);

  useEffect(() => {
    if (max < 1 && playing) setPlaying(false);
  }, [max, playing]);

  useEffect(() => {
    // Only one playback per page may own the global keyboard shortcuts.
    if (!keys) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          go(-1);
          break;
        case "ArrowRight":
          e.preventDefault();
          go(1);
          break;
        case "Home":
          setIdx(0);
          break;
        case "End":
          setIdx(max);
          break;
        case "Enter":
          e.preventDefault();
          if (max >= 0) setIdx((i) => (i >= max ? 0 : i + 1));
          break;
        case " ":
          e.preventDefault();
          if (max >= 1) setPlaying((p) => !p);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, setIdx, max, keys]);

  return {
    idx,
    setIdx,
    playing,
    setPlaying,
    speedMs,
    setSpeedMs,
    go,
    max,
    atStart: idx <= 0,
    atEnd: idx >= max,
  };
}
