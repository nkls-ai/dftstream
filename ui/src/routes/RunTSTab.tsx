import { useState } from "react";
import { EnergyChart } from "../components/EnergyChart";
import { PlaybackBar } from "../components/PlaybackBar";
import { SkeletonChart, SkeletonPanel } from "../components/Skeleton";
import { StructureViewer } from "../components/StructureViewer";
import { usePlayback } from "../hooks/usePlayback";
import { hasIRData } from "../lib/irSpectrum";
import { Callout, CollapsibleSection, Headline, HeadlineTile, ResizableSplit, Section } from "./runDetailUi";
import { IRSpectrumChart, ThermoBlock } from "./RunChemistryWidgets";
import { RunTSFrequencyTable } from "./RunTSFrequencyTable";
import { TSSpectrumSection } from "./RunTSFreqSpectrum";
import { RunTSImagModeSection } from "./RunTSImagModeSection";
import { RunHessianHistoryStrip, type HessianSelection } from "./RunHessianHistoryStrip";
import { useTSTabData } from "./tsTabData";
import { hasThermoData } from "./tsTabLogic";
import { useEhFormatter } from "../lib/useEnergyFormat";

export function TSTab({ runId }: { runId: string }) {
  const [selectedHess, setSelectedHess] = useState<HessianSelection>("latest");
  const {
    loading,
    run,
    settings,
    thermo,
    irScale,
    freqHistory,
    realFreqs,
    imagFreqs,
    vibByMode,
    hessianOptions,
    items,
    trajectoryXyzs,
    energyData,
    freqSpectrumData,
    verdict,
    usesRecalcHess,
    hasFinalFreq,
    strictOptTS,
    isScanTS,
  } = useTSTabData(runId, selectedHess);
  const fmtEh = useEhFormatter();

  // Strip selection <-> vib-artifact hessian key ("final" | zero-padded
  // ordinal). Only correlate when a matching artifact key exists; otherwise
  // the imag-mode section keeps its own picker state.
  const imagHessKey =
    selectedHess === "latest"
      ? "final"
      : hessianOptions.find((k) => k !== "final" && Number(k) === selectedHess);
  const onPickerHessian = (k: string) => {
    if (k === "final") {
      setSelectedHess("latest");
      return;
    }
    const ordinal = Number(k);
    setSelectedHess(freqHistory.byHess.has(ordinal) ? ordinal : "latest");
  };

  const lastGeom = items.length > 0 ? items[items.length - 1] : null;
  const pb = usePlayback(items.length, { follow: run?.status === "running" });
  const currentGeom = items[pb.idx] ?? lastGeom;

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

  const finalEnergy = energyData.length > 0 ? energyData[energyData.length - 1]!.y : null;

  return (
    <div className="tab-shell">
      <Headline>
        <HeadlineTile
          label="TS verdict"
          value={verdict.label}
          tone={verdict.tone}
        />
        {imagFreqs.length > 0 && (
          <HeadlineTile
            label="Imaginary freq"
            value={imagFreqs.map((f) => f.wavenumber.toFixed(0)).join(", ")}
            unit="cm⁻¹"
            tone={imagFreqs.length === 1 ? "ok" : "warn"}
          />
        )}
        {strictOptTS && (
          <HeadlineTile
            label="Opt cycles"
            value={energyData.length || "—"}
            sub={finalEnergy != null ? `${fmtEh(finalEnergy)} Eh` : undefined}
          />
        )}
        {thermo?.gibbsEh != null && (
          <HeadlineTile
            label="Gibbs G"
            value={fmtEh(thermo.gibbsEh)}
            unit="Eh"
          />
        )}
      </Headline>

      <Callout
        tone={verdict.tone === "ok" ? "ok" : verdict.tone === "bad" ? "bad" : "warn"}
        icon={verdict.tone === "ok" ? "✓" : verdict.tone === "bad" ? "✕" : "△"}
      >
        {verdict.detail}
      </Callout>

      {isScanTS && (
        <Callout tone="warn" icon="△">
          ScanTS phase attribution is not yet supported: every relaxed-scan
          point prints its own convergence banner, so the verdict above may
          reflect a scan point rather than the final TS optimization. Check
          the output log before trusting it.
        </Callout>
      )}

      {verdict.tone === "ok" && usesRecalcHess && !hasFinalFreq && (
        <Callout tone="warn" icon="△">
          Frequencies come from the optimizer's recalculated hessian
          (%geom Calc_Hess/Recalc_Hess), which is approximate — run a final
          Freq on the converged geometry for publication-quality frequencies.
        </Callout>
      )}

      {/* ---- Live hessian timeline (Recalc_Hess / restarted freq runs) ---- */}
      <RunHessianHistoryStrip
        history={freqHistory}
        selected={selectedHess}
        onSelect={setSelectedHess}
        expectedImagCount={1}
      />

      {/* ---- Imaginary mode vibration (full width) ---- */}
      <RunTSImagModeSection
        vibByMode={vibByMode}
        hessianOptions={hessianOptions}
        imagFreqs={imagFreqs}
        lastGeomXyz={lastGeom?.xyz ?? null}
        itemCount={items.length}
        selectedHessian={imagHessKey}
        onSelectHessian={imagHessKey != null ? onPickerHessian : undefined}
      />

      {/* ---- Trajectory + charts side by side (plain OptTS only: for
           NEB-TS the stored geometries/energies span the whole band) ---- */}
      {strictOptTS && items.length > 1 && currentGeom && (
        <ResizableSplit
          defaultLeftPct={55}
          left={
            <Section title="Optimization trajectory" sub={<span>cycle {currentGeom.cycle} / {items.length}</span>}>
              <div className="card" style={{ padding: 12 }}>
                <StructureViewer
                  xyz={currentGeom.xyz}
                  trajectory={trajectoryXyzs}
                  frameIndex={pb.idx}
                />
                <PlaybackBar
                  pb={pb}
                  label={(i) => `Cycle ${items[i]?.cycle ?? i + 1}`}
                />
              </div>
            </Section>
          }
          right={
            <div style={{ display: "grid", gap: 16 }}>
              {freqSpectrumData.length > 0 && (
                <TSSpectrumSection data={freqSpectrumData} realCount={realFreqs.length} imagFreqs={imagFreqs} />
              )}

              {energyData.length > 1 && (
                <Section title="Optimization convergence" sub={<span>{energyData.length} cycles</span>}>
                  <EnergyChart
                    data={energyData}
                    xLabel="opt cycle"
                    yLabel="E (Eh)"
                    height={180}
                    markerX={currentGeom?.cycle ?? null}
                    onClickPoint={(i) => {
                      // energyData is keyed/sorted by cycle and may not be
                      // index-aligned with the geometry array (energies and
                      // geometries can have different cycle coverage). Map the
                      // clicked point's cycle back to its geometry.
                      const cycle = energyData[i]?.x;
                      const t = items.findIndex((g) => g.cycle === cycle);
                      if (t >= 0) pb.setIdx(t);
                    }}
                  />
                </Section>
              )}

              {hasThermoData(thermo) && (
                <ThermoBlock thermo={thermo} decimals={settings.energyDecimals} simple={settings.simpleMode} />
              )}
            </div>
          }
        />
      )}

      {/* Show charts without split when there's no trajectory (single-cycle or NEB-TS runs) */}
      {(!strictOptTS || items.length <= 1) && (freqSpectrumData.length > 0 || thermo) && (
        <div style={{ display: "grid", gap: 16 }}>
          {freqSpectrumData.length > 0 && (
            <TSSpectrumSection data={freqSpectrumData} realCount={realFreqs.length} imagFreqs={imagFreqs} />
          )}
          {hasThermoData(thermo) && (
            <ThermoBlock thermo={thermo} decimals={settings.energyDecimals} simple={settings.simpleMode} />
          )}
        </div>
      )}

      {hasIRData(realFreqs) && (
        <CollapsibleSection title="IR spectrum" sub={<span>Lorentzian broadened · {realFreqs.filter((f) => (f.irIntensity ?? 0) > 0).length} active modes{irScale ? ` · scaled ×${irScale.toFixed(4)}` : ""}</span>} defaultOpen={false} storageKey="run.ts.irSpectrum">
          <div className="card" style={{ padding: 16 }}>
            <IRSpectrumChart freqs={realFreqs} scaleFactor={irScale} />
          </div>
        </CollapsibleSection>
      )}

      {realFreqs.length > 0 && (
        <RunTSFrequencyTable freqs={realFreqs} />
      )}
    </div>
  );
}
