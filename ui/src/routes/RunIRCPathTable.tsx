import type { IRCPathPoint } from "./irc";
import { Section } from "./runDetailUi";
import { useEhFormatter, useRelEnergyFormat } from "../lib/useEnergyFormat";

export function RunIRCPathTable({
  path,
  selectedIdx,
  onSelect,
}: {
  path: IRCPathPoint[];
  selectedIdx: number;
  onSelect: (idx: number) => void;
}) {
  const fmtEh = useEhFormatter();
  const rel = useRelEnergyFormat();
  return (
    <Section title="IRC path details" sub="click a row or the chart">
      <div className="scan-table-wrap sticky-head">
        <table className="table scan-table">
          <thead>
            <tr>
              <th>Step</th>
              <th>Direction</th>
              <th>Energy (Eh)</th>
              <th>ΔE ({rel.label})</th>
              <th aria-label="Actions"></th>
            </tr>
          </thead>
          <tbody>
            {path.map((p, i) => (
              <tr
                key={`${p.direction}-${p.pathIndex}`}
                className={
                  (i === selectedIdx ? "scan-row-selected" : "") +
                  (p.pathIndex === 0 ? " neb-ts-row" : "")
                }
                onClick={() => onSelect(i)}
              >
                <td className="mono">{p.pathIndex}</td>
                <td>{p.pathIndex === 0 ? "TS" : p.direction}</td>
                <td className="mono">{fmtEh(p.energy)}</td>
                <td className="mono">{rel.formatKcal(p.relativeKcal)}</td>
                <td>
                  {i === 0 ? "Reactant" : i === path.length - 1 ? "Product" : p.pathIndex === 0 ? <span className="neb-ts-badge">TS</span> : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
