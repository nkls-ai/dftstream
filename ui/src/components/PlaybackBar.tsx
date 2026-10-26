import type { Playback } from "../hooks/usePlayback";

export function PlaybackBar({
  pb,
  label,
}: {
  pb: Playback;
  label?: (idx: number, count: number) => string;
}) {
  const { idx, setIdx, playing, setPlaying, speedMs, setSpeedMs, go, max, atStart, atEnd } = pb;
  const count = max + 1;
  const text = label ? label(idx, count) : `${idx + 1} / ${count}`;

  return (
    <div className="playback">
      <div className="playback-left">
        <button type="button" className="pb-step" onClick={() => setIdx(0)} disabled={atStart} title="First (Home)">⏮</button>
        <button type="button" className="pb-step" onClick={() => go(-1)} disabled={atStart} title="Prev (←)">◀</button>
        <button type="button"
          className={"pb-play" + (playing ? " playing" : "")}
          onClick={() => setPlaying((p: boolean) => !p)}
          disabled={max < 1}
          title={playing ? "Pause (Space)" : "Play / loop (Space)"}
          aria-label={playing ? "Pause" : "Play"}
        >
          <span className="pb-play-icon">{playing ? "❚❚" : "▶"}</span>
          <span className="pb-play-label">{playing ? "Looping" : "Play"}</span>
        </button>
        <button type="button" className="pb-step" onClick={() => go(1)} disabled={atEnd && !playing} title="Next (→)">▶</button>
        <button type="button" className="pb-step" onClick={() => setIdx(max)} disabled={atEnd} title="Last (End)">⏭</button>
      </div>
      <input aria-label="Playback speed"
        type="range"
        className="pb-range"
        min={0}
        max={max}
        value={Math.min(idx, max)}
        onChange={(e) => setIdx(Number(e.target.value))}
      />
      <div className="playback-right">
        <select
          className="pb-speed"
          value={speedMs}
          onChange={(e) => setSpeedMs(Number(e.target.value))}
          title="Playback speed"
        >
          <option value={150}>4× fast</option>
          <option value={300}>2× fast</option>
          <option value={600}>1× normal</option>
          <option value={1200}>½× slow</option>
        </select>
        <span className="mono pb-counter">{text}</span>
      </div>
    </div>
  );
}
