import { useMemo } from "react";
import { EnergyChart } from "../components/EnergyChart";
import { PlaybackBar } from "../components/PlaybackBar";
import { SkeletonChart, SkeletonPanel } from "../components/Skeleton";
import { StructureViewer } from "../components/StructureViewer";
import { useDataSource } from "../data/DataSource";
import { usePlayback } from "../hooks/usePlayback";
import { buildGapSeries, buildMecpPoints, buildRelativeEnergySeries, mecpFinalStats } from "./mecpData";
import { Callout, Headline, HeadlineTile, ResizableSplit, Section } from "./runDetailUi";
import { RunMECPCycleTable } from "./RunMECPCycleTable";
import { RunMECPStateChart } from "./RunMECPStateChart";
import { useEhFormatter, useRelEnergyFormat } from "../lib/useEnergyFormat";

export function MECPTab({ runId }: { runId: string }) {
  const ds = useDataSource();
  const fmtEh = useEhFormatter();
  const rel = useRelEnergyFormat();
  const run = ds.useRun(runId);
  const state1 = ds.useRunMetrics(runId, "mecp_state1_energy");
  const state2 = ds.useRunMetrics(runId, "mecp_state2_energy");
  const gaps = ds.useRunMetrics(runId, "mecp_gap");
  const geoms = ds.useRunGeometries(runId);

  const points = useMemo(
    () => buildMecpPoints(state1.data, state2.data, gaps.data),
    [gaps.data, state1.data, state2.data],
  );
  // Built in kcal/mol; shown in the user's unit.
  const gapData = useMemo(() => rel.seriesFromKcal(buildGapSeries(points)), [points, rel]);
  const energyData = useMemo(() => buildRelativeEnergySeries(points), [points]);

  const items = useMemo(
    () => (geoms.data ? [...geoms.data].sort((a, b) => a.cycle - b.cycle) : []),
    [geoms.data],
  );
  const pb = usePlayback(items.length);
  const currentGeom = items[pb.idx] ?? items[items.length - 1] ?? null;
  const selectedCycle = currentGeom?.cycle ?? points[points.length - 1]?.cycle ?? null;

  const { finalGapKcal, finalEnergy } = mecpFinalStats(points);
  const converged = run.data?.converged === true || (finalGapKcal != null && finalGapKcal < 0.1);

  const loading = run.loading || state1.loading || state2.loading || gaps.loading || geoms.loading;
  if (loading) {
    return (
      <div className="tab-shell">
        <div className="split">
          <SkeletonPanel rows={5} height={400} />
          <SkeletonChart />
        </div>
      </div>
    );
  }

  if (points.length === 0 && items.length === 0) {
    return (
      <div className="empty-state">
        No MECP crossing data found yet. DFTStream detected the run type, but
        the output did not expose two-state MECP energies in a recognized form.
      </div>
    );
  }

  return (
    <div className="tab-shell">
      <Headline>
        <HeadlineTile
          label="MECP verdict"
          value={converged ? "Crossing found" : "Tracking crossing"}
          tone={converged ? "ok" : "warn"}
        />
        <HeadlineTile
          label="Final gap"
          value={rel.formatKcal(finalGapKcal, 1)}
          unit={finalGapKcal != null ? rel.label : undefined}
          tone={finalGapKcal != null && finalGapKcal < 0.1 ? "ok" : "warn"}
        />
        <HeadlineTile
          label="MECP energy"
          value={fmtEh(finalEnergy)}
          unit={finalEnergy != null ? "Eh" : undefined}
          sub="average of the two surfaces"
        />
        <HeadlineTile label="Cycles" value={points.length || items.length} />
      </Headline>

      <Callout tone={converged ? "ok" : "warn"}>
        MECP runs are about trust in the crossing, not only the final energy. The
        important signal is that the two spin-state surfaces collapse to a small
        gap while the geometry stabilizes.
      </Callout>

      <ResizableSplit
        defaultLeftPct={54}
        left={
          <Section
            title="Crossing geometry"
            sub={currentGeom ? <span>cycle {currentGeom.cycle}</span> : undefined}
          >
            {currentGeom ? (
              <div className="card" style={{ padding: 12 }}>
                <StructureViewer
                  xyz={currentGeom.xyz}
                  trajectory={items.map((g) => g.xyz)}
                  frameIndex={pb.idx}
                />
                <PlaybackBar pb={pb} label={(i) => `Cycle ${items[i]?.cycle ?? i + 1}`} />
              </div>
            ) : (
              <div className="empty-state">No MECP geometries available.</div>
            )}
          </Section>
        }
        right={
          <div style={{ display: "grid", gap: 16 }}>
            <Section title="Energy gap" sub={<span>surface 2 - surface 1</span>}>
              <div className="card" style={{ padding: "12px 8px" }}>
                <EnergyChart
                  data={gapData}
                  xLabel="MECP cycle"
                  yLabel={`Gap (${rel.label})`}
                  formatValue={rel.formatValue}
                  height={240}
                  markerX={selectedCycle}
                  onClickPoint={(idx) => {
                    const cycle = gapData[idx]?.x;
                    const geomIdx = items.findIndex((g) => g.cycle === cycle);
                    if (geomIdx >= 0) pb.setIdx(geomIdx);
                  }}
                />
              </div>
            </Section>

            <RunMECPStateChart data={energyData} selectedCycle={selectedCycle} />
          </div>
        }
      />

      <RunMECPCycleTable points={points} />
    </div>
  );
}
