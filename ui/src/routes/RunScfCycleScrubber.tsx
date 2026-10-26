export function RunScfCycleScrubber({
  passCount,
  activeIdx,
  activeLabel,
  onSelect,
  onStep,
}: {
  /** SCF solves across all cycles (a cycle may hold more than one). */
  passCount: number;
  activeIdx: number;
  /** e.g. "cycle 9" or "cycle 9 · SCF 2/2" (see scfPassLabel). */
  activeLabel: string;
  onSelect: (idx: number) => void;
  onStep: (delta: number) => void;
}) {
  const atStart = activeIdx <= 0;
  const atEnd = activeIdx >= passCount - 1;
  return (
    <div
      className="playback"
      role="group"
      aria-label="SCF cycle scrubber"
    >
      <div className="playback-left">
        <button type="button"
          className="pb-step"
          onClick={() => onSelect(0)}
          disabled={atStart}
          title="First cycle"
          aria-label="First cycle"
        >
          ⏮
        </button>
        <button type="button"
          className="pb-step"
          onClick={() => onStep(-1)}
          disabled={atStart}
          title="Prev cycle"
          aria-label="Previous cycle"
        >
          ◀
        </button>
        <button type="button"
          className="pb-step"
          onClick={() => onStep(1)}
          disabled={atEnd}
          title="Next cycle"
          aria-label="Next cycle"
        >
          ▶
        </button>
        <button type="button"
          className="pb-step"
          onClick={() => onSelect(passCount - 1)}
          disabled={atEnd}
          title="Last cycle"
          aria-label="Last cycle"
        >
          ⏭
        </button>
      </div>
      <input
        type="range"
        className="pb-range"
        min={0}
        max={passCount - 1}
        value={activeIdx}
        onChange={(e) => onSelect(Number(e.target.value))}
        aria-label="Scrub through SCF cycles"
        aria-valuetext={`${activeLabel}, ${activeIdx + 1} of ${passCount}`}
      />
      <div className="playback-right">
        <span className="mono pb-counter">
          {activeLabel} · {activeIdx + 1} / {passCount}
        </span>
      </div>
    </div>
  );
}
