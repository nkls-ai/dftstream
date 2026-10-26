import { useMemo } from "react";
import { useDataSource } from "../data/DataSource";
import { SkeletonChart } from "../components/Skeleton";
import { StructureViewer } from "../components/StructureViewer";
import { VibPlayer } from "../components/VibPlayer";
import { EnergyChart } from "../components/EnergyChart";
import { PlaybackBar } from "../components/PlaybackBar";
import { usePlayback } from "../hooks/usePlayback";
import { extractVibModeIndex } from "./runDetailParsers";
import { groupFrequenciesByHessian } from "../lib/frequencyHistory";

/**
 * Structure preview for a selected pathway point: trajectory scrubber plus
 * the imaginary-mode VibPlayer when the point is a transition state.
 */
export function PathwayPointStructure({ runId, isTS }: { runId: string; isTS: boolean }) {
  const ds = useDataSource();
  const geoms = ds.useRunGeometries(runId);
  const metrics = ds.useRunMetrics(runId, "final_sp");
  const freqs = ds.useRunFrequencies(runId);
  const vibs = ds.useRunVibModes(runId);

  const items = useMemo(
    () => (geoms.data ? [...geoms.data].sort((a, b) => a.cycle - b.cycle) : []),
    [geoms.data],
  );

  const pb = usePlayback(items.length);
  const { idx, max } = pb;

  const energyData = useMemo(
    () =>
      (metrics.data ?? [])
        .sort((a, b) => (a.cycle ?? 0) - (b.cycle ?? 0))
        .map((p) => ({ x: p.cycle ?? 0, y: p.value })),
    [metrics.data],
  );

  const imagVibXyz = useMemo(() => {
    if (!isTS) return null;
    const imagFreq = groupFrequenciesByHessian(freqs.data).latest.find((f) => f.imaginary);
    if (!imagFreq) return null;
    for (const v of vibs.data ?? []) {
      const mode = extractVibModeIndex(v.name);
      if (mode === imagFreq.idx) return v.contentText;
    }
    return null;
  }, [isTS, freqs.data, vibs.data]);

  if (geoms.loading) return <SkeletonChart />;
  if (!items.length && !imagVibXyz) return <div className="empty-state">No geometry available.</div>;

  const active = items[Math.min(idx, max)];
  const activeCycle = active?.cycle;

  return (
    <div className="pathway-point-detail">
      {isTS && imagVibXyz ? (
        <div className="pathway-point-viewer">
          <VibPlayer xyzMulti={imagVibXyz} />
        </div>
      ) : active ? (
        <div className="pathway-point-viewer">
          <StructureViewer xyz={active.xyz} />
          {items.length > 1 && (
            <PlaybackBar
              pb={pb}
              label={(i) => `cycle ${items[i]?.cycle ?? 0} · ${i + 1}/${items.length}`}
            />
          )}
        </div>
      ) : null}

      {energyData.length > 1 && (
        <div className="pathway-point-chart">
          <EnergyChart
            data={energyData}
            xLabel="opt cycle"
            yLabel="E (Eh)"
            height={160}
            markerX={activeCycle ?? null}
            onClickPoint={(i) => {
              const cycle = energyData[i]?.x;
              if (cycle == null) return;
              const target = items.findIndex((g) => g.cycle === cycle);
              if (target >= 0) pb.setIdx(target);
            }}
          />
        </div>
      )}
    </div>
  );
}
