import { useMemo, useState } from "react";
import { SortableTh } from "../components/SortableTh";
import { useDataSource } from "../data/DataSource";
import { useTableSort } from "../hooks/useTableSort";
import { useChartColors } from "../lib/chartColors";
import {
  buildShiftTable,
  computeNMRSpectrum,
  isSupportedNMRNucleus,
  nucleusLabel,
  SUPPORTED_NMR_NUCLEI,
  TMS_REFERENCES,
  type NMRShiftRow,
  type SupportedNMRNucleus,
} from "../lib/nmrSpectrum";
import type { SortAccessors } from "../lib/tableSort";
import { RunNMRSpectrumChart } from "./RunNMRSpectrumChart";
import { Section } from "./runDetailUi";

const NMR_SORT_ACCESSORS: SortAccessors<NMRShiftRow> = {
  atom: (s) => s.atomIdx,
  element: (s) => s.element,
  sigma: (s) => s.isotropic,
  delta: (s) => s.shift,
  aniso: (s) => s.anisotropy,
};

export function NMRTab({ runId }: { runId: string }) {
  const ds = useDataSource();
  const shields = ds.useRunNMRShields(runId);
  const chartColors = useChartColors();

  const data = useMemo(() => shields.data ?? [], [shields.data]);
  const nuclei = useMemo(() => {
    const set = new Set(data.map((s) => s.element));
    return SUPPORTED_NMR_NUCLEI.filter((n) => set.has(n));
  }, [data]);
  const omittedNuclei = useMemo(() => {
    const supported = new Set<string>(SUPPORTED_NMR_NUCLEI);
    return Array.from(new Set(data.map((s) => s.element)))
      .filter((n) => !supported.has(n))
      .sort();
  }, [data]);

  const [selectedNucleus, setSelectedNucleus] = useState<string>("");
  const activeNucleus: SupportedNMRNucleus =
    isSupportedNMRNucleus(selectedNucleus) && nuclei.includes(selectedNucleus)
      ? selectedNucleus
      : nuclei[0] ?? "H";
  const reference = TMS_REFERENCES[activeNucleus];

  const spectrum = useMemo(
    () => computeNMRSpectrum(data, activeNucleus, reference),
    [data, activeNucleus, reference],
  );

  const shiftTable = useMemo(
    () => buildShiftTable(data, activeNucleus, reference),
    [data, activeNucleus, reference],
  );

  const table = useTableSort("nmr");
  const sortedShifts = table.sorted(shiftTable, NMR_SORT_ACCESSORS);

  if (shields.loading) {
    return <div className="tab-shell"><div className="empty-state">Loading NMR data…</div></div>;
  }
  if (data.length === 0) {
    return <div className="tab-shell"><div className="empty-state">No NMR shielding data available.</div></div>;
  }
  if (nuclei.length === 0) {
    return (
      <div className="tab-shell">
        <div className="empty-state">
          No <sup>1</sup>H or <sup>13</sup>C NMR shielding data available.
        </div>
      </div>
    );
  }

  return (
    <div className="tab-shell">
      <Section
        title={`${nucleusLabel(activeNucleus).mass}${activeNucleus} NMR Chemical Shifts`}
        sub={
          <span>
            {shiftTable.length} atom{shiftTable.length !== 1 ? "s" : ""} ·
            referenced to TMS: δ = σ<sub>ref</sub> − σ<sub>calc</sub>
            (σ<sub>ref</sub> = {reference.toFixed(1)} ppm)
          </span>
        }
      >
        {nuclei.length > 1 && (
          <div style={{ marginBottom: 12, display: "flex", gap: 6 }}>
            {nuclei.map((n) => (
              <button
                key={n}
                type="button"
                className={"chip" + (n === activeNucleus ? " chip-active" : "")}
                onClick={() => setSelectedNucleus(n)}
              >
                <sup>{nucleusLabel(n).mass}</sup>{n}
              </button>
            ))}
          </div>
        )}

        {spectrum.length > 0 && (
          <RunNMRSpectrumChart spectrum={spectrum} nucleus={activeNucleus} chartColors={chartColors} />
        )}

        <div className="card sticky-head" style={{ padding: 0, overflow: "auto", maxHeight: 420 }}>
          <table className="data-table">
            <thead>
              <tr>
                <SortableTh label="Atom #" sortKey="atom" table={table} />
                <SortableTh label="Element" sortKey="element" table={table} />
                <SortableTh label="σ (ppm)" sortKey="sigma" table={table} />
                <SortableTh label="δ vs TMS (ppm)" sortKey="delta" table={table} />
                <SortableTh label="Anisotropy" sortKey="aniso" table={table} defaultDir="desc" />
              </tr>
            </thead>
            <tbody>
              {sortedShifts.map((s) => (
                <tr key={s.id}>
                  <td className="mono">{s.atomIdx}</td>
                  <td>{s.element}</td>
                  <td className="mono">{s.isotropic.toFixed(2)}</td>
                  <td className="mono">{s.shift.toFixed(2)}</td>
                  <td className="mono dim">{s.anisotropy.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {omittedNuclei.length > 0 && (
          <p className="dim" style={{ marginTop: 10 }}>
            Only <sup>1</sup>H and <sup>13</sup>C spectra are shown; omitted shielding rows for {omittedNuclei.join(", ")}.
          </p>
        )}
      </Section>
    </div>
  );
}
