import type { MECPPoint } from "./mecpData";
import { Section } from "./runDetailUi";
import { useEhFormatter, useRelEnergyFormat } from "../lib/useEnergyFormat";

// Per-cycle table of the two surface energies and their gap.
export function RunMECPCycleTable({ points }: { points: MECPPoint[] }) {
  const fmtEh = useEhFormatter();
  const rel = useRelEnergyFormat();
  return (
    <Section title="Cycle table">
      <div className="card sticky-head" style={{ overflow: "auto", maxHeight: 420 }}>
        <table className="artifact-table">
          <thead>
            <tr>
              <th>Cycle</th>
              <th>Surface 1 / Eh</th>
              <th>Surface 2 / Eh</th>
              <th>Gap / {rel.label}</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.cycle}>
                <td className="mono">{p.cycle}</td>
                <td className="mono">{fmtEh(p.state1Energy)}</td>
                <td className="mono">{fmtEh(p.state2Energy)}</td>
                <td className="mono">{rel.format(p.gapEh, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
