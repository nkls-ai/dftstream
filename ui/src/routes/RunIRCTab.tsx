import { useMemo } from "react";
import { EnergyChart } from "../components/EnergyChart";
import { PlaybackBar } from "../components/PlaybackBar";
import { SkeletonPanel } from "../components/Skeleton";
import { usePlayback } from "../hooks/usePlayback";
import { useIRCData } from "./ircData";
import {
  buildIRCAnnotations,
  buildIRCChartData,
  ircEndpointDeltasKcal,
  ircStepLabel,
} from "./ircDisplay";
import { Headline, HeadlineTile, ResizableSplit, Section } from "./runDetailUi";
import { RunIRCPathTable } from "./RunIRCPathTable";
import { RunIRCStructurePanel } from "./RunIRCStructurePanel";
import { useRelEnergyFormat } from "../lib/useEnergyFormat";

export function IRCTab({ runId }: { runId: string }) {
  const { loading, ircSummary, path } = useIRCData(runId);

  const rel = useRelEnergyFormat();
  // Built in kcal/mol; shown in the user's unit.
  const chartData = useMemo(() => rel.seriesFromKcal(buildIRCChartData(path)), [path, rel]);
  const annotations = useMemo(() => rel.seriesFromKcal(buildIRCAnnotations(path)), [path, rel]);

  const pb = usePlayback(path.length);
  const selected = path[pb.idx];
  const tsIdx = path.findIndex((p) => p.pathIndex === 0);

  if (loading) {
    return (
      <div className="tab-shell">
        <SkeletonPanel rows={8} height={360} />
      </div>
    );
  }
  if (!ircSummary) {
    return <div className="empty-state">No IRC data found in this run's output.</div>;
  }

  const { fwdDeltaKcal, bwdDeltaKcal } = ircEndpointDeltasKcal(ircSummary);

  const ircChart = chartData.length > 0 ? (
    <Section title="Reaction coordinate" sub="click on the curve to inspect a point">
      <div style={{ position: "relative" }}>
        <EnergyChart
          data={chartData}
          xLabel="IRC step"
          yLabel={`ΔE (${rel.label})`}
          formatValue={rel.formatValue}
          height={320}
          markerX={selected ? selected.pathIndex : null}
          markerLabel={selected ? `step ${selected.pathIndex}` : undefined}
          onClickPoint={(i) => pb.setIdx(i)}
          annotations={annotations}
        />
        {path.length > 1 && (
          <PlaybackBar pb={pb} label={(i) => ircStepLabel(i, path, tsIdx)} />
        )}
      </div>
    </Section>
  ) : null;

  const ircStructure = selected?.xyz ? (
    <RunIRCStructurePanel
      selected={selected}
      xyz={selected.xyz}
      idx={pb.idx}
      tsIdx={tsIdx}
      pathLength={path.length}
    />
  ) : null;

  return (
    <div className="tab-shell">
      <Headline>
        <HeadlineTile label="Steps" value={path.length} />
        {fwdDeltaKcal != null && (
          <HeadlineTile label="Forward ΔE" value={rel.formatKcal(fwdDeltaKcal)} unit={rel.label} />
        )}
        {bwdDeltaKcal != null && (
          <HeadlineTile label="Backward ΔE" value={rel.formatKcal(bwdDeltaKcal)} unit={rel.label} />
        )}
        <HeadlineTile
          label="Status"
          value={ircSummary.converged ? "Converged" : "Not converged"}
        />
      </Headline>

      {ircChart && ircStructure ? (
        <ResizableSplit defaultLeftPct={67} left={ircStructure} right={ircChart} />
      ) : (
        ircChart ?? ircStructure
      )}

      {path.length > 0 && (
        <RunIRCPathTable path={path} selectedIdx={pb.idx} onSelect={pb.setIdx} />
      )}
    </div>
  );
}
