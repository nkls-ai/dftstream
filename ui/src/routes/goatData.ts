import { useMemo } from "react";
import { useDataSource } from "../data/DataSource";
import type { Artifact } from "../data/types";
import {
  mergeGoatConformerXYZ,
  withBoltzmannPopulations,
  type GoatConformer,
  type GoatSummary,
} from "./goat";
import { isFinalGoatEnsemble, isGoatGlobalMinimum } from "./goatArtifacts";
import { pickOutArtifact } from "./runDetailArtifacts";
import { useParsedArtifact } from "./useParsedArtifact";

export interface GoatData {
  loading: boolean;
  summary: GoatSummary | null;
  conformers: GoatConformer[];
  chartData: { x: number; y: number }[];
  ensemble: Artifact | null;
  globalMinXYZ: string | undefined;
}

// useGoatData resolves the GOAT summary from the run's .out artifact and
// combines it with the final-ensemble / global-minimum xyz artifacts into
// a population-weighted conformer list plus the search-convergence series.
export function useGoatData(runId: string): GoatData {
  const ds = useDataSource();
  const arts = ds.useRunArtifacts(runId);
  const outId = useMemo(() => pickOutArtifact(arts.data), [arts.data]);
  const ensemble = arts.data?.find(isFinalGoatEnsemble) ?? null;
  const globalMin = arts.data?.find(isGoatGlobalMinimum) ?? null;
  const goatParsed = useParsedArtifact(outId, "goat");
  const ensembleContent = ds.useArtifactContent(ensemble?.id ?? null);
  const globalMinContent = ds.useArtifactContent(globalMin?.id ?? null);

  const summary = goatParsed.data;
  const conformers = useMemo(
    () =>
      withBoltzmannPopulations(
        mergeGoatConformerXYZ(summary, ensembleContent.data?.contentText),
        summary?.ensembleTemperatureK ?? 298.15,
      ),
    [summary, ensembleContent.data],
  );
  const chartData = useMemo(
    () =>
      (summary?.iterations ?? []).map((point) => ({
        x: point.iter,
        y: point.minEnergyEh,
      })),
    [summary],
  );

  return {
    loading: arts.loading || goatParsed.loading || ensembleContent.loading || globalMinContent.loading,
    summary,
    conformers,
    chartData,
    ensemble,
    globalMinXYZ: globalMinContent.data?.contentText,
  };
}
