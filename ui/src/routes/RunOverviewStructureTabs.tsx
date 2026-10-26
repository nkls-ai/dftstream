import { useMemo } from "react";
import { useDataSource } from "../data/DataSource";
import { EnergyChart } from "../components/EnergyChart";
import { PlaybackBar } from "../components/PlaybackBar";
import { SkeletonChart, SkeletonDetail, SkeletonPanel } from "../components/Skeleton";
import { usePlayback } from "../hooks/usePlayback";
import { useSettings } from "../lib/settings";
import { runWallMs } from "../lib/time";
import { hasIRData } from "../lib/irSpectrum";
import {
  isMinimizationRun,
  isNEBBandRun,
  isTSSearchRun,
  overviewConvergence,
  stationaryPointVerdict,
} from "../lib/convergence";
import { Callout, CollapsibleSection, ResizableSplit, Section } from "./runDetailUi";
import { pickOutArtifact } from "./runDetailArtifacts";
import { IRSpectrumChart, ThermoBlock } from "./RunChemistryWidgets";
import { mergeRunThermo } from "./runDetailParsers";
import { useParsedArtifact, useWorkerParse } from "./useParsedArtifact";
import { resolveIrScale, solventDisplayLabel } from "./runOverviewData";
import { InputEcho } from "./RunOverviewInputEcho";
import { RunDetailsDisclosure } from "./RunOverviewRunDetails";
import { RunOverviewSummaryBand } from "./RunOverviewSummaryBand";
import { RunOverviewMetaStrip } from "./RunOverviewMetaStrip";
import { buildEnergyData, isScanInput, sortGeometriesByCycle } from "./runStructureData";
import { useRunStructureCubes } from "./useRunStructureCubes";
import { useRunStructureVib } from "./useRunStructureVib";
import { RunStructureGeometrySection } from "./RunStructureGeometrySection";
import { RunStructureVibSection } from "./RunStructureVibSection";
import { PropertiesPanel } from "./RunStructurePropertiesPanel";
import { RunNotesSection } from "./RunAnnotations";
import { RunDiagnosisPanel } from "./RunDiagnosisPanel";
import { RunLineageSection } from "./RunLineage";
import { RunHessianHistoryStrip } from "./RunHessianHistoryStrip";
import { groupFrequenciesByHessian } from "../lib/frequencyHistory";
import { useEhFormatter } from "../lib/useEnergyFormat";

export function OverviewTab({ runId }: { runId: string }) {
  const ds = useDataSource();
  const [settings] = useSettings();
  const ed = settings.energyDecimals;
  const run = ds.useRun(runId);
  const freqs = ds.useRunFrequencies(runId);
  const arts = ds.useRunArtifacts(runId);
  const outId = useMemo(() => pickOutArtifact(arts.data), [arts.data]);
  const outContent = ds.useArtifactFullText(outId);
  const parsedThermo = useWorkerParse("thermo", outContent.fullText).data;
  const thermo = mergeRunThermo(run.data, parsedThermo);
  const outProps = useWorkerParse("outProperties", outContent.fullText).data;
  const freqHistory = useMemo(() => groupFrequenciesByHessian(freqs.data), [freqs.data]);
  const r = run.data;
  // `!r` conflated "still loading" with "resolved to nothing". useRun returns
  // {data: undefined, loading: false} for a run that does not exist (deleted,
  // or a stale bookmark), so the old check left a skeleton shimmering forever
  // with no way to tell it apart from a slow query.
  if (run.loading) return <SkeletonDetail />;
  if (!r) return <div className="empty-state">Run not found. It may have been deleted.</div>;

  const irScale = resolveIrScale(settings.irScaleFactors, r.functional, r.basis);

  const imagFreqs = freqHistory.latest.filter((f) => f.imaginary);
  const isTSSearch = isTSSearchRun(r);
  // NEB bands are convergence-gated too: finishing without the band
  // converging is not success.
  const isOptish = isMinimizationRun(r) || isTSSearch || isNEBBandRun(r);
  const hasFreq = freqHistory.latest.length > 0;

  const convergence = overviewConvergence(r, isOptish, {
    loading: arts.loading || (outId != null && outContent.loading),
    hasOut: outId != null,
    text: outContent.fullText,
  });

  // "Minimum vs transition state" verdict from imaginary mode count.
  const minVerdict = stationaryPointVerdict(r, hasFreq, imagFreqs.map((f) => f.wavenumber));

  const wallMs = runWallMs(r);
  const solventLabel = solventDisplayLabel(r);

  return (
    <div className="tab-shell">
      {/* ---- Summary band: energy + convergence ---- */}
      <RunOverviewSummaryBand
        r={r}
        energyDecimals={ed}
        isOptish={isOptish}
        isOptTS={isTSSearch}
        convergence={convergence}
        thermo={thermo}
        hasFreq={hasFreq}
        imagFreqs={imagFreqs}
        spin={outProps?.spin ?? null}
      />

      {/* ---- Failure diagnosis (terminal-failed runs only) ---- */}
      <RunDiagnosisPanel run={r} />

      {/* ---- Verdict band ---- */}
      {minVerdict && (
        <Callout
          tone={minVerdict.tone}
          icon={minVerdict.tone === "bad" ? "✕" : "△"}
        >
          {minVerdict.text}
        </Callout>
      )}

      {/* ---- Method / molecule metadata strip ---- */}
      <RunOverviewMetaStrip r={r} solventLabel={solventLabel} />

      {/* ---- Thermochemistry ---- */}
      {thermo && (thermo.gibbsEh != null || thermo.zpeEh != null) ? (
        <ThermoBlock thermo={thermo} decimals={ed} simple={settings.simpleMode} />
      ) : null}

      {/* ---- Input file (path + collapsible echo) ---- */}
      {(r.inputPath || r.inputText) && (
        <Section title="Input file">
          <InputEcho text={r.inputText ?? ""} path={r.inputPath} />
        </Section>
      )}

      {/* ---- Workflow lineage (restart / `dftstream next` chains) ---- */}
      <RunLineageSection run={r} />

      {/* ---- Lab-notebook notes ---- */}
      <RunNotesSection run={r} />


      {/* ---- Hessian timeline (runs with several freq calculations) ---- */}
      <RunHessianHistoryStrip
        history={freqHistory}
        selected="latest"
        expectedImagCount={isTSSearch ? 1 : 0}
      />

      {/* ---- IR Spectrum (if available) ---- */}
      {hasIRData(freqHistory.latest) && (
        <CollapsibleSection title="IR spectrum" sub={<span>Lorentzian broadened{irScale ? ` · scaled ×${irScale.toFixed(4)}` : ""}</span>} defaultOpen={false} storageKey="run.overview.irSpectrum">
          <div className="card" style={{ padding: 16 }}>
            <IRSpectrumChart freqs={freqHistory.latest} scaleFactor={irScale} />
          </div>
        </CollapsibleSection>
      )}

      {/* ---- Keywords ---- */}
      {r.keywords?.length ? (
        <div
          className="mono"
          style={{
            padding: "8px 12px",
            background: "var(--hover-wash)",
            borderRadius: 6,
            fontSize: 12,
            color: "var(--text-muted)",
            wordBreak: "break-word",
          }}
        >
          <span style={{ color: "var(--text-faint)" }}>!</span>{" "}
          {r.keywords.join(" ")}
        </div>
      ) : null}

      {/* ---- Run details (collapsible, closed by default) ---- */}
      <RunDetailsDisclosure r={r} wallMs={wallMs} />
    </div>
  );
}

export function StructureTab({ runId }: { runId: string }) {
  const ds = useDataSource();
  const run = ds.useRun(runId);
  const geoms = ds.useRunGeometries(runId);
  const items = useMemo(() => sortGeometriesByCycle(geoms.data), [geoms.data]);
  const trajectoryXyzs = useMemo(() => items.map((g) => g.xyz), [items]);
  // A running optimization shows its newest geometry as it arrives.
  const pb = usePlayback(items.length, { follow: run.data?.status === "running" });
  const { idx, max } = pb;
  const fmtEh = useEhFormatter();

  const points = ds.useRunMetrics(runId, "final_sp");
  const geomCycles = useMemo(() => new Set(items.map((g) => g.cycle)), [items]);
  const energyData = useMemo(
    () => buildEnergyData(points.data, geomCycles),
    [points.data, geomCycles],
  );

  // Properties panel: lazy-fetch the .out artifact and parse
  // HOMO/LUMO + Mulliken charges + dipole. Cheap because the artifact
  // is chunked + cached by Convex once it's been opened anywhere.
  const arts = ds.useRunArtifacts(runId);
  const outId = useMemo(() => pickOutArtifact(arts.data), [arts.data]);
  const outContent = useParsedArtifact(outId, "outProperties");
  const properties = outContent.data;

  const vib = useRunStructureVib(runId);

  const isFinished = run.data?.status === "finished" || run.data?.status === "failed";

  const { orbitals, hasPerCycle } = useRunStructureCubes(
    runId,
    items[idx]?.cycle,
    properties?.orbitals?.homoMO,
    properties?.orbitals?.lumoMO,
  );

  if (geoms.loading) {
    return (
      <div className="tab-shell">
        <div className="split">
          <SkeletonPanel rows={7} height={460} />
          <SkeletonChart />
        </div>
      </div>
    );
  }
  if (!items.length) return <div className="empty-state">No geometries yet.</div>;
  const active = items[Math.min(idx, max)];
  if (!active) return null;
  const activeCycle = active.cycle;
  const isScanRun = isScanInput(run.data?.inputText);
  return (
    <div className="tab-shell">
      {isScanRun && (
        <Callout tone="info" icon="↗">
          This is a <strong>relaxed surface scan</strong>. The structures below are the opt cycles within a single scan step.
          Switch to the <strong>Scan</strong> tab for the full potential energy surface with one converged structure per scan point.
        </Callout>
      )}
      <ResizableSplit
        defaultLeftPct={67}
        left={
          <RunStructureGeometrySection
            items={items}
            idx={idx}
            active={active}
            activeCycle={activeCycle}
            trajectoryXyzs={trajectoryXyzs}
            orbitals={orbitals}
            charges={properties?.npa ?? properties?.mulliken ?? properties?.loewdin ?? undefined}
            dipole={
              properties?.dipoleVecAU && properties.dipoleDebye != null
                ? { vec: properties.dipoleVecAU, debye: properties.dipoleDebye }
                : null
            }
            runName={run.data?.name ?? "run"}
          />
        }
        right={
          <Section
            title="Energy per opt cycle"
            sub={
              <span style={{ color: "var(--text)" }}>
                {fmtEh(energyData.find((p) => p.x === activeCycle)?.y)}{" "}
                <span className="unit" style={{ color: "var(--text-faint)" }}>
                  Eh
                </span>
              </span>
            }
          >
            <EnergyChart
              data={energyData}
              xLabel="opt cycle"
              yLabel="E (Eh)"
              height={240}
              markerX={activeCycle}
              onClickPoint={(i) => {
                const cycle = energyData[i]?.x;
                if (cycle == null) return;
                const target = items.findIndex((g) => g.cycle === cycle);
                if (target >= 0) pb.setIdx(target);
              }}
            />
            <PlaybackBar pb={pb} label={(i) => `cycle ${items[i]?.cycle ?? 0} · ${i + 1} / ${items.length}`} />
          </Section>
        }
      />

      <RunStructureVibSection vib={vib} />

      <PropertiesPanel
        properties={properties}
        loading={outId !== null && outContent.loading}
        hasOut={outId !== null}
        cubesPresent={orbitals.length > 0}
        runFinished={isFinished}
        hasPerCycle={hasPerCycle}
      />
    </div>
  );
}
