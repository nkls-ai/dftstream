import type { CriticalPoint, ScanPoint, ScanSummary } from "./scan";
import { Section } from "./runDetailUi";
import { useEhFormatter, useRelEnergyFormat } from "../lib/useEnergyFormat";

// Table of every scan point with its coordinates, energy, and critical-point
// badge. Clicking a row selects that point.
export function RunScanPointsTable({
  summary,
  points,
  crits,
  selectedIdx,
  minE,
  onSelect,
}: {
  summary: ScanSummary;
  points: ScanPoint[];
  crits: CriticalPoint[];
  selectedIdx: number;
  minE: number;
  onSelect: (idx: number) => void;
}) {
  const fmtEh = useEhFormatter();
  const rel = useRelEnergyFormat();
  return (
    <Section title="Scan points" sub="click a row or the chart">
      <div className="scan-table-wrap sticky-head">
        <table className="table scan-table">
          <thead>
            <tr>
              <th>Step</th>
              {summary.coordinates.slice(0, Math.min(3, summary.dimensions)).map((coord) => (
                <th key={coord.label}>{coord.label}</th>
              ))}
              <th>Energy (Eh)</th>
              <th>ΔE ({rel.label})</th>
              <th aria-label="Actions"></th>
            </tr>
          </thead>
          <tbody>
            {points.map((p, i) => {
              const crit = crits.find((c) => c.idx === i);
              return (
                <tr
                  key={p.step}
                  className={[
                    i === selectedIdx ? "scan-row-selected" : "",
                    crit ? `scan-crit-${crit.kind}` : "",
                  ].filter(Boolean).join(" ") || undefined}
                  onClick={() => onSelect(i)}
                >
                  <td className="mono">{p.step}</td>
                  {summary.coordinates.slice(0, Math.min(3, summary.dimensions)).map((coord, coordIdx) => (
                    <td className="mono" key={`${p.step}-${coord.label}`}>
                      {p.coords[coordIdx]?.toFixed(4) ?? ""}
                    </td>
                  ))}
                  <td className="mono">{fmtEh(p.energy)}</td>
                  <td className="mono">{rel.format(p.energy - minE)}</td>
                  <td>
                    {crit && <span className={`scan-crit-badge ${crit.kind}`}>{crit.kind === "minimum" ? "Min" : crit.kind === "maximum" ? "Max" : "Saddle"}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
