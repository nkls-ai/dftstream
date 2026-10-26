import { useMemo, useState } from "react";
import { useDataSource } from "../data/DataSource";
import type { Frequency } from "../data/types";
import { groupFrequenciesByHessian } from "../lib/frequencyHistory";
import { buildVibModeMap } from "./runStructureData";

export interface RunStructureVib {
  /** Imaginary frequencies that have a playable displacement trajectory. */
  playableImag: Frequency[];
  /** The mode actually shown: the user's pick if still playable, else the
   *  first playable imaginary mode, else null. */
  effectiveImagMode: number | null;
  activeImag: Frequency | undefined;
  /** Multi-frame xyz for the active mode, null when nothing is playable. */
  activeVibCube: string | null;
  selectImagMode: (idx: number) => void;
}

/**
 * Frequencies + vib-mode trj artifacts — needed so we can show the
 * imaginary-mode animation inside the Structure tab (the dedicated
 * Frequencies tab is gone; chemists wanted everything close to the
 * structure).
 */
export function useRunStructureVib(runId: string): RunStructureVib {
  const ds = useDataSource();
  const freqs = ds.useRunFrequencies(runId);
  const vibs = ds.useRunVibModes(runId);
  const vibByMode = useMemo(() => buildVibModeMap(vibs.data), [vibs.data]);
  const latestFreqs = useMemo(
    () => groupFrequenciesByHessian(freqs.data).latest,
    [freqs.data],
  );
  const playableImag = latestFreqs.filter(
    (f) => f.imaginary && vibByMode.has(f.idx),
  );
  const [selectedImagMode, setSelectedImagMode] = useState<number | null>(null);
  const effectiveImagMode =
    selectedImagMode != null &&
    playableImag.some((f) => f.idx === selectedImagMode)
      ? selectedImagMode
      : playableImag[0]?.idx ?? null;
  const activeImag = playableImag.find((f) => f.idx === effectiveImagMode);
  const activeVibCube = activeImag
    ? vibByMode.get(activeImag.idx) ?? null
    : null;
  return {
    playableImag,
    effectiveImagMode,
    activeImag,
    activeVibCube,
    selectImagMode: setSelectedImagMode,
  };
}
