import { PlaybackBar } from "../components/PlaybackBar";
import { SkeletonChart } from "../components/Skeleton";
import { StructureViewer } from "../components/StructureViewer";
import { usePlayback } from "../hooks/usePlayback";
import { Headline, HeadlineTile, ResizableSplit, Section } from "./runDetailUi";
import { RunScanPointsTable } from "./RunScanPointsTable";
import { ScanSurfacePlot } from "./RunScanSurfacePlot";
import { coordValueText, minScanEnergy, scanCritStats } from "./scanSurface";
import { useScanTabData } from "./scanTabData";
import { useEhFormatter, useRelEnergyFormat } from "../lib/useEnergyFormat";

export function ScanTab({ runId }: { runId: string }) {
  const { loading, summary, points, crits } = useScanTabData(runId);
  const pb = usePlayback(points.length);
  const selectedIdx = pb.idx;
  const fmtEh = useEhFormatter();
  const rel = useRelEnergyFormat();

  if (loading) {
    return (
      <div className="tab-shell">
        <SkeletonChart />
      </div>
    );
  }
  if (!summary || points.length === 0) {
    return (
      <div className="empty-state">
        No relaxed surface scan data found in this run's output.
      </div>
    );
  }

  const selected = points[selectedIdx];
  const minE = minScanEnergy(points);
  const { barrier, saddle, minimaCount } = scanCritStats(summary.dimensions, crits);

  const scanChart = (
    <Section
      title={summary.dimensions > 1 ? `${Math.min(3, summary.dimensions)}D potential surface` : "Potential energy surface"}
      sub={summary.coordLabel}
    >
      <ScanSurfacePlot
        summary={summary}
        points={points}
        selectedIdx={selectedIdx}
        onSelect={(i) => pb.setIdx(i)}
        criticalPoints={crits}
      />
      <PlaybackBar pb={pb} label={(i) => `step ${points[i]?.step ?? i + 1} · ${i + 1} / ${points.length}`} />
    </Section>
  );
  const scanStructure = selected?.xyz ? (
    <Section
      title="Structure"
      sub={
        <span>
          step <span style={{ color: "var(--text)" }}>{selected.step}</span> ·{" "}
          <span className="mono" style={{ color: "var(--text)" }}>{coordValueText(summary, selected)}</span> ·{" "}
          <span className="mono" style={{ color: "var(--text)" }}>{fmtEh(selected.energy)}</span>{" "}
          <span style={{ color: "var(--text-faint)" }}>Eh</span> ·{" "}
          ΔE <span className="mono">{rel.format(selected.energy - minE)}</span>{" "}
          <span style={{ color: "var(--text-faint)" }}>{rel.label}</span>
        </span>
      }
    >
      <div className="card" style={{ padding: 12 }}>
        <StructureViewer xyz={selected.xyz} />
      </div>
    </Section>
  ) : null;

  return (
    <div className="tab-shell">
      <Headline>
        <HeadlineTile label="Scan points" value={points.length} />
        <HeadlineTile
          label="Min energy"
          value={fmtEh(minE)}
          unit="Eh"
        />
        {barrier != null && (
          <HeadlineTile label="Barrier" value={rel.formatKcal(barrier)} unit={rel.label} tone="warn" />
        )}
        {minimaCount > 1 && (
          <HeadlineTile label="Minima" value={minimaCount} />
        )}
        {saddle && (
          <HeadlineTile label="Saddle point" value={rel.formatKcal(saddle.deltaE)} unit={rel.label} />
        )}
      </Headline>

      {scanStructure ? (
        <ResizableSplit defaultLeftPct={67} left={scanStructure} right={scanChart} />
      ) : (
        scanChart
      )}

      <RunScanPointsTable
        summary={summary}
        points={points}
        crits={crits}
        selectedIdx={selectedIdx}
        minE={minE}
        onSelect={(i) => pb.setIdx(i)}
      />
    </div>
  );
}
