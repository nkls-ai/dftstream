import type { FrequencyHistory } from "../lib/frequencyHistory";
import { Section } from "./runDetailUi";

export type HessianSelection = number | "latest";

/** Live timeline of every hessian calculation pushed so far: one chip per
 *  hessian with its imaginary-mode count and wavenumbers. Clicking a chip
 *  switches the frequency table / spectrum / vibration player to that
 *  hessian. Renders nothing for runs with a single (or legacy) hessian. */
export function RunHessianHistoryStrip({
  history,
  selected,
  onSelect,
  expectedImagCount,
}: {
  history: FrequencyHistory;
  selected: HessianSelection;
  onSelect?: (h: HessianSelection) => void;
  /** 1 on TS tabs, 0 on minimization overviews — drives the chip tone. */
  expectedImagCount: number;
}) {
  if (history.hessIndices.length < 2) return null;
  return (
    <Section
      title="Hessian history"
      sub={<span>{history.hessIndices.length} hessian calculations · live</span>}
    >
      <div className="hess-history" role={onSelect ? "tablist" : undefined}>
        {history.hessIndices.map((h) => {
          const isLatest = h === history.latestHessIdx;
          const active = selected === h || (selected === "latest" && isLatest);
          const imag = (history.byHess.get(h) ?? []).filter((f) => f.imaginary);
          const tone = imag.length === expectedImagCount ? "ok" : "warn";
          const label = isLatest ? `final (#${h})` : `#${h}`;
          const chip = (
            <>
              <span className="hess-chip-label">{label}</span>
              <span className={`hess-chip-imag ${tone}`}>
                {imag.length} imag
                {imag.length > 0 && (
                  <span className="hess-chip-wave">
                    {" "}
                    {imag.map((f) => f.wavenumber.toFixed(0)).join(", ")} cm⁻¹
                  </span>
                )}
              </span>
            </>
          );
          if (!onSelect) {
            return (
              <span key={h} className={"hess-chip" + (active ? " active" : "")}>
                {chip}
              </span>
            );
          }
          return (
            <button
              key={h}
              type="button"
              role="tab"
              aria-selected={active}
              className={"hess-chip" + (active ? " active" : "")}
              onClick={() => onSelect(isLatest ? "latest" : h)}
            >
              {chip}
            </button>
          );
        })}
      </div>
    </Section>
  );
}
