import { useMemo } from "react";
import { useDataSource } from "../data/DataSource";
import type { Frequency, Geometry, Run } from "../data/types";
import { hasExplicitFreq, isOptTSRun, tsVerdict, type TSVerdict } from "../lib/convergence";
import { computeFreqSpectrum } from "../lib/irSpectrum";
import { groupFrequenciesByHessian, type FrequencyHistory } from "../lib/frequencyHistory";
import { useSettings, type Settings } from "../lib/settings";
import { pickOutArtifact } from "./runDetailArtifacts";
import { mergeRunThermo, type Thermo } from "./runDetailParsers";
import {
  buildCycleEnergySeries,
  groupVibModes,
  resolveIrScale,
  usesRecalcHess,
  type VibModeGroups,
} from "./tsTabLogic";
import { useParsedArtifact } from "./useParsedArtifact";

export interface TSTabData {
  loading: boolean;
  run: Run | undefined;
  settings: Settings;
  thermo: Thermo | null;
  irScale: number | undefined;
  /** All frequency pushes grouped by hessian calculation. */
  freqHistory: FrequencyHistory;
  /** Modes of the selected hessian (the newest one by default). */
  realFreqs: Frequency[];
  imagFreqs: Frequency[];
  vibByMode: VibModeGroups;
  hessianOptions: string[];
  items: Geometry[];
  trajectoryXyzs: string[];
  energyData: { x: number; y: number }[];
  freqSpectrumData: { x: number; y: number }[];
  verdict: TSVerdict;
  usesRecalcHess: boolean;
  hasFinalFreq: boolean;
  /**
   * True for a plain OptTS run. NEB-TS variants share this tab but their
   * stored geometries/energies span the whole band, so the opt-trajectory
   * sections would mislead and are hidden.
   */
  strictOptTS: boolean;
  /** ScanTS run — verdicts are unreliable until the scan→TS handoff is parsed. */
  isScanTS: boolean;
}

// Fetches everything the TS tab renders (run record, frequencies, geometries,
// vib modes, energies, thermochemistry) and derives its display series.
// `selectedHess` switches the mode-level data (spectrum, tables, imag list)
// to a historical hessian; the verdict always reflects the newest one.
export function useTSTabData(
  runId: string,
  selectedHess: number | "latest" = "latest",
): TSTabData {
  const ds = useDataSource();
  const [settings] = useSettings();
  const run = ds.useRun(runId);
  const freqs = ds.useRunFrequencies(runId);
  const geoms = ds.useRunGeometries(runId);
  const vibs = ds.useRunVibModes(runId);
  const points = ds.useRunMetrics(runId, "final_sp");
  const arts = ds.useRunArtifacts(runId);
  const outId = useMemo(() => pickOutArtifact(arts.data), [arts.data]);
  const thermo = mergeRunThermo(run.data, useParsedArtifact(outId, "thermo").data);

  const r = run.data;
  const irScale = r ? resolveIrScale(settings.irScaleFactors, r.functional, r.basis) : undefined;

  const freqHistory = useMemo(() => groupFrequenciesByHessian(freqs.data), [freqs.data]);
  const selectedFreqs =
    selectedHess === "latest"
      ? freqHistory.latest
      : freqHistory.byHess.get(selectedHess) ?? freqHistory.latest;
  const realFreqs = selectedFreqs.filter((f) => f.wavenumber !== 0);
  const imagFreqs = realFreqs.filter((f) => f.imaginary);
  const latestImag = freqHistory.latest.filter((f) => f.wavenumber !== 0 && f.imaginary);

  const { vibByMode, hessianOptions } = useMemo(() => groupVibModes(vibs.data), [vibs.data]);

  const items = useMemo(
    () => (geoms.data ? [...geoms.data].sort((a, b) => a.cycle - b.cycle) : []),
    [geoms.data],
  );
  const trajectoryXyzs = useMemo(() => items.map((g) => g.xyz), [items]);
  const energyData = useMemo(() => buildCycleEnergySeries(points.data), [points.data]);

  const verdict = tsVerdict(r, freqHistory.latest.length, latestImag.map((f) => f.wavenumber));

  const freqSpectrumData = useMemo(
    () => computeFreqSpectrum(realFreqs, { xMin: 0, xMax: 4200, scaleFactor: irScale }),
    [realFreqs, irScale],
  );

  return {
    loading: freqs.loading && geoms.loading,
    run: r,
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
    usesRecalcHess: usesRecalcHess(r?.inputText),
    hasFinalFreq: r ? hasExplicitFreq(r) : false,
    strictOptTS: r ? isOptTSRun(r) : true,
    isScanTS: r?.runTypes?.includes("SCANTS") ?? false,
  };
}
