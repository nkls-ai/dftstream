import { useMemo } from "react";
import { useDataSource } from "../data/DataSource";
import { TimeChart } from "../components/TimeChart";
import { SkeletonChart } from "../components/Skeleton";
import { Headline, HeadlineTile, Section } from "./runDetailUi";

export { LogTab } from "./RunLogTab";
export { ScfTab } from "./RunScfTab";

export function HardwareTab({ runId }: { runId: string }) {
  const ds = useDataSource();
  const sys = ds.useRunSysSamples(runId);
  const run = ds.useRun(runId);
  const samples = useMemo(
    () => (sys.data ?? []).slice().sort((a, b) => a.ts - b.ts),
    [sys.data],
  );
  const startTs = run.data?.startedAt ?? samples[0]?.ts;
  const cpuPts = useMemo(
    () => samples.map((s) => ({ ts: s.ts, value: s.cpuPct })),
    [samples],
  );
  const rssPts = useMemo(
    () => samples.map((s) => ({ ts: s.ts, value: s.rssMb })),
    [samples],
  );
  if (sys.loading) {
    return (
      <div className="tab-shell">
        <div className="split equal">
          <SkeletonChart />
          <SkeletonChart />
        </div>
      </div>
    );
  }
  if (!samples.length) {
    return (
      <div className="empty-state">
        No hardware samples yet. The wrapper samples every 5s by default; run
        with <code>--sysinterval 1s</code> to capture short jobs.
      </div>
    );
  }
  const lastCpu = samples[samples.length - 1]!.cpuPct;
  const lastRss = samples[samples.length - 1]!.rssMb;
  const peakRss = samples.reduce((m, s) => Math.max(m, s.rssMb), 0);
  const peakCpu = samples.reduce((m, s) => Math.max(m, s.cpuPct), 0);

  return (
    <div className="tab-shell">
      <Headline>
        <HeadlineTile
          label="Peak CPU"
          value={`${peakCpu.toFixed(0)}`}
          unit="%"
          sub={`now ${lastCpu.toFixed(1)} %`}
          tone={peakCpu > 100 ? "ok" : peakCpu > 50 ? "warn" : undefined}
        />
        <HeadlineTile
          label="Peak RSS"
          value={peakRss.toFixed(0)}
          unit="MB"
          sub={`now ${lastRss.toFixed(0)} MB`}
        />
        <HeadlineTile
          label="Samples"
          value={samples.length}
          sub={`every ${
            samples.length > 1
              ? Math.round((samples[1]!.ts - samples[0]!.ts) / 1000)
              : "?"
          }s`}
        />
      </Headline>

      <Section title="Resource trace" sub="from wrapper sysinfo sampler">
        <div className="scope-stack">
          <div className="scope">
            <div className="scope-head">
              <div className="scope-title">CPU</div>
              <div className="scope-readout">
                <span className="lo">now</span>
                {lastCpu.toFixed(1)} %{" "}
                <span className="lo" style={{ marginLeft: 10 }}>peak</span>
                {peakCpu.toFixed(1)} %
              </div>
            </div>
            <div className="scope-body">
              <TimeChart
                data={cpuPts}
                yLabel="CPU %"
                unit="%"
                hue="teal"
                startTs={startTs}
              />
            </div>
          </div>
          <div className="scope">
            <div className="scope-head">
              <div className="scope-title">Memory (RSS)</div>
              <div className="scope-readout">
                <span className="lo">now</span>
                {lastRss.toFixed(1)} MB{" "}
                <span className="lo" style={{ marginLeft: 10 }}>peak</span>
                {peakRss.toFixed(1)} MB
              </div>
            </div>
            <div className="scope-body">
              <TimeChart
                data={rssPts}
                yLabel="RSS (MB)"
                unit="MB"
                hue="blue"
                startTs={startTs}
              />
            </div>
          </div>
        </div>
      </Section>
    </div>
  );
}
