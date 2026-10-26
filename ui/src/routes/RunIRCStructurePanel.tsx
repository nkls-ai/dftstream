import { StructureViewer } from "../components/StructureViewer";
import type { IRCPathPoint } from "./irc";
import { Section } from "./runDetailUi";
import { useRelEnergyFormat } from "../lib/useEnergyFormat";

export function RunIRCStructurePanel({
  selected,
  xyz,
  idx,
  tsIdx,
  pathLength,
}: {
  selected: IRCPathPoint;
  xyz: string;
  idx: number;
  tsIdx: number;
  pathLength: number;
}) {
  const rel = useRelEnergyFormat();
  return (
    <Section
      title="Structure"
      sub={
        <span>
          {idx === 0 ? (
            <span style={{ color: "rgb(var(--teal))" }}>Reactant</span>
          ) : idx === tsIdx ? (
            <span style={{ color: "rgb(var(--gold))" }}>Transition State</span>
          ) : idx === pathLength - 1 ? (
            <span style={{ color: "rgb(var(--violet))" }}>Product</span>
          ) : (
            <span>step {selected.pathIndex}</span>
          )}
          {" · "}
          <span className="mono" style={{ color: "var(--text)" }}>
            {rel.formatKcal(selected.relativeKcal)}
          </span>{" "}
          <span style={{ color: "var(--text-faint)" }}>{rel.label}</span>
        </span>
      }
    >
      <div className="card" style={{ padding: 12 }}>
        <StructureViewer xyz={xyz} />
      </div>
    </Section>
  );
}
