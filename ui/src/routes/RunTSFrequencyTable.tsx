import { useState } from "react";
import { SortableTh } from "../components/SortableTh";
import { useTableSort } from "../hooks/useTableSort";
import type { Frequency } from "../data/types";
import type { SortAccessors } from "../lib/tableSort";
import { hasIRData } from "../lib/irSpectrum";
import { Section } from "./runDetailUi";

const FREQ_SORT_ACCESSORS: SortAccessors<Frequency> = {
  mode: (f) => f.idx,
  freq: (f) => f.wavenumber,
  ir: (f) => f.irIntensity,
  type: (f) => (f.imaginary ? "imaginary" : "real"),
};

// All computed frequencies in mode order, flagging imaginary modes.
export function RunTSFrequencyTable({ freqs }: { freqs: Frequency[] }) {
  const table = useTableSort("ts-freq");
  const [imaginaryOnly, setImaginaryOnly] = useState(false);

  const showIR = hasIRData(freqs);
  const byMode = [...freqs].sort((a, b) => a.idx - b.idx);
  const filtered = imaginaryOnly ? byMode.filter((f) => f.imaginary) : byMode;
  const rows = table.sorted(filtered, FREQ_SORT_ACCESSORS);

  return (
    <Section title="All frequencies" sub={<span>{freqs.length} modes</span>}>
      <div className="table-toolbar">
        <button
          type="button"
          className={"chip" + (imaginaryOnly ? " chip-active" : "")}
          aria-pressed={imaginaryOnly}
          onClick={() => setImaginaryOnly((v) => !v)}
        >
          Imaginary only
        </button>
        {imaginaryOnly && (
          <span className="table-toolbar-count">
            {filtered.length} of {byMode.length} modes
          </span>
        )}
      </div>
      <div className="card sticky-head" style={{ overflow: "auto", maxHeight: 420 }}>
        <table className="freq-table">
          <thead>
            <tr>
              <SortableTh label="Mode" sortKey="mode" table={table} />
              <SortableTh label="Frequency (cm⁻¹)" sortKey="freq" table={table} />
              {showIR && <SortableTh label="IR intensity (km/mol)" sortKey="ir" table={table} defaultDir="desc" />}
              <SortableTh label="Type" sortKey="type" table={table} />
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => (
              <tr key={f.idx} className={f.imaginary ? "ts-imag-row" : ""}>
                <td className="mono">{f.idx}</td>
                <td className="mono">{f.wavenumber.toFixed(2)}</td>
                {showIR && (
                  <td className="mono">{f.irIntensity != null ? f.irIntensity.toFixed(2) : "—"}</td>
                )}
                <td>
                  {f.imaginary ? (
                    <span className="ts-imag-badge">imaginary</span>
                  ) : (
                    <span className="dim">real</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
