import { useState } from "react";
import { StructureViewer } from "../components/StructureViewer";
import { VibPlayer } from "../components/VibPlayer";
import type { Frequency } from "../data/types";
import { Section } from "./runDetailUi";
import type { VibModeGroups } from "./tsTabLogic";

// Hessian picker plus the imaginary-mode vibration player. Falls back to a
// static TS geometry (single-cycle runs) or an empty state when no vibration
// data is available. Owns the hessian/mode selection state.
export function RunTSImagModeSection({
  vibByMode,
  hessianOptions,
  imagFreqs,
  lastGeomXyz,
  itemCount,
  selectedHessian: controlledHessian,
  onSelectHessian,
}: {
  vibByMode: VibModeGroups;
  hessianOptions: string[];
  imagFreqs: Frequency[];
  lastGeomXyz: string | null;
  itemCount: number;
  /** Controlled hessian key ("final" or a byHess key); the section owns
   *  the selection itself when absent. */
  selectedHessian?: string;
  onSelectHessian?: (h: string) => void;
}) {
  const [ownHessian, setOwnHessian] = useState("final");
  const selectedHessian = controlledHessian ?? ownHessian;
  const selectHessian = (h: string) => {
    if (onSelectHessian) {
      onSelectHessian(h);
    } else {
      setOwnHessian(h);
    }
  };
  const activeVibMap = selectedHessian === "final"
    ? vibByMode.final
    : vibByMode.byHess.get(selectedHessian) ?? new Map<number, string>();

  const playableImag = imagFreqs.filter((f) => activeVibMap.has(f.idx));
  const [selectedImagMode, setSelectedImagMode] = useState<number | null>(null);
  const effectiveImagMode = selectedImagMode != null && playableImag.some((f) => f.idx === selectedImagMode)
    ? selectedImagMode
    : playableImag[0]?.idx ?? null;
  const activeImag = playableImag.find((f) => f.idx === effectiveImagMode);
  const activeVibCube = activeImag ? activeVibMap.get(activeImag.idx) ?? null : null;

  return (
    <>
      {hessianOptions.length > 1 && (
        <div className="hess-picker">
          <label className="dim" htmlFor="ts-hessian-select" style={{ fontSize: 12 }}>Hessian</label>
          <select
            id="ts-hessian-select"
            value={selectedHessian}
            onChange={(e) => { selectHessian(e.target.value); setSelectedImagMode(null); }}
            style={{ fontSize: 12 }}
          >
            {hessianOptions.map((h) => (
              <option key={h} value={h}>
                {h === "final" ? "Final" : `Intermediate #${h}`}
              </option>
            ))}
          </select>
        </div>
      )}
      {activeVibCube ? (
        <Section
          title="Imaginary mode"
          sub={
            activeImag ? (
              <span>
                mode {activeImag.idx} ·{" "}
                <span style={{ color: "rgb(var(--rose))" }}>
                  {activeImag.wavenumber.toFixed(2)} cm⁻¹
                </span>
              </span>
            ) : undefined
          }
        >
          {playableImag.length > 1 && (
            <div className="imag-list">
              {playableImag.map((f) => (
                <button
                  key={f.idx}
                  className={
                    "imag-row" + (f.idx === effectiveImagMode ? " active" : "")
                  }
                  onClick={() => setSelectedImagMode(f.idx)}
                  type="button"
                >
                  <span className="mode-idx">mode {f.idx}</span>
                  <span />
                  <span className="wave">{f.wavenumber.toFixed(2)} cm⁻¹</span>
                </button>
              ))}
            </div>
          )}
          <div className="card" style={{ padding: 12 }}>
            <VibPlayer xyzMulti={activeVibCube} />
          </div>
        </Section>
      ) : lastGeomXyz != null && itemCount <= 1 ? (
        <Section title="TS geometry">
          <div className="card" style={{ padding: 12 }}>
            <StructureViewer xyz={lastGeomXyz} />
          </div>
        </Section>
      ) : itemCount === 0 ? (
        <Section title="Imaginary mode">
          <div className="empty-state">No vibration data available.</div>
        </Section>
      ) : null}
    </>
  );
}
