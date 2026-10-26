import { useMemo, useState } from "react";
import { EnergyChart } from "../components/EnergyChart";
import { useDataSource } from "../data/DataSource";
import { Headline, HeadlineTile, Section } from "./runDetailUi";
import { RunScfCycleScrubber } from "./RunScfCycleScrubber";
import { scfPassLabel, scfPasses, scfDeltaTone, scfSeriesStats } from "./scfSeries";
import { useEhFormatter } from "../lib/useEnergyFormat";

export function ScfTab({ runId }: { runId: string }) {
  const ds = useDataSource();
  const points = ds.useRunMetrics(runId, "scf_iter_energy");
  const run = ds.useRun(runId);
  const fmtEh = useEhFormatter();
  const passes = useMemo(() => scfPasses(points.data), [points.data]);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const activeIdx = Math.min(
    selectedIdx ?? passes.length - 1,
    Math.max(0, passes.length - 1),
  );
  const active = passes[activeIdx];
  const data = active?.series ?? [];
  const activeLabel = active ? scfPassLabel(active) : "";
  const cycleCount = new Set(passes.map((p) => p.cycle)).size;

  const { lastE, dE, span } = scfSeriesStats(data);

  const go = (delta: number) =>
    setSelectedIdx(
      Math.max(0, Math.min(passes.length - 1, activeIdx + delta)),
    );

  if (passes.length === 0) {
    return (
      <div className="tab-shell">
        <Section title="SCF convergence">
          <div className="dim" style={{ fontSize: 13, lineHeight: 1.5 }}>
            No SCF iteration data captured yet. The wrapper records each
            iteration as the run progresses - this tab will populate live.
          </div>
        </Section>
      </div>
    );
  }

  return (
    <div className="tab-shell">
      <Headline>
        <HeadlineTile
          label="Iterations"
          value={data.length || "—"}
          sub={`${activeLabel} · ${cycleCount} cycles`}
        />
        <HeadlineTile
          label="Converged E"
          value={fmtEh(lastE)}
          unit="Eh"
          tone="ok"
        />
        <HeadlineTile
          label="ΔE final step"
          value={dE != null ? dE.toExponential(2) : "—"}
          unit="Eh"
          tone={scfDeltaTone(dE)}
        />
        <HeadlineTile
          label="Energy span"
          value={span != null ? span.toExponential(2) : "—"}
          unit="Eh"
          sub={run.data?.scfTier ? `tier · ${run.data.scfTier}` : undefined}
        />
      </Headline>

      <Section
        title="SCF iteration energy"
        sub={
          <span>
            <span style={{ color: "var(--text)" }}>{activeLabel}</span> ·{" "}
            {data.length} iter
          </span>
        }
      >
        {passes.length > 1 && (
          <RunScfCycleScrubber
            passCount={passes.length}
            activeIdx={activeIdx}
            activeLabel={activeLabel}
            onSelect={setSelectedIdx}
            onStep={go}
          />
        )}
        <EnergyChart data={data} xLabel="iter" yLabel="E (Eh)" height={280} />
      </Section>
    </div>
  );
}
