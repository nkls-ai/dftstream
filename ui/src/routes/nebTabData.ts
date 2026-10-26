import { useMemo } from "react";
import { parseMultiXYZ } from "../components/xyz";
import { useDataSource } from "../data/DataSource";
import { chunkPathFrames, mergeNEBXYZ, parseNEBInterp, parseNEBInterpIterations, type NEBImage, type NEBInterpIteration, type NEBSummary } from "./neb";
import { buildBarrierChart, buildImageChartData, buildMepChart, type ChartPoint } from "./nebPath";
import { pickOutArtifact } from "./runDetailArtifacts";
import { useParsedArtifact } from "./useParsedArtifact";

export type NEBInterpData = ReturnType<typeof parseNEBInterp>;

export interface NebTabData {
  loading: boolean;
  nebSummary: NEBSummary | null;
  interpData: NEBInterpData | null;
  images: NEBImage[];
  /** True when energies come from the output's PATH SUMMARY (already kcal/mol, Å). */
  usePathSummary: boolean;
  mepChart: ChartPoint[];
  imageChartData: ChartPoint[];
  barrierChart: ChartPoint[];
  tsXyz: string | undefined;
  /** Interpolated starting path (one single-frame XYZ per image), [] when absent. */
  initialPathFrames: string[];
  /** Every Iteration block of the .interp file (energy profile per NEB step). */
  interpIterations: NEBInterpIteration[];
  /** Band geometries per NEB iteration from _MEP_ALL_trj.xyz, chunked into
   *  one string[] of single-frame XYZs per iteration; [] when unavailable. */
  pathsByIteration: string[][];
}

// Fetches the NEB artifacts (output, .interp, MEP trajectory, initial
// interpolated path, converged TS structure) and derives the image list plus
// all chart series.
export function useNebTabData(runId: string): NebTabData {
  const ds = useDataSource();
  const arts = ds.useRunArtifacts(runId);
  const outId = useMemo(() => pickOutArtifact(arts.data), [arts.data]);
  const nebParsed = useParsedArtifact(outId, "neb");
  const interpArt = useMemo(
    () => arts.data?.find((a) => /\.final\.interp$/i.test(a.name) || /\.interp$/i.test(a.name)) ?? null,
    [arts.data],
  );
  const interpContent = ds.useArtifactContent(interpArt?.id ?? null);
  const mepArt = useMemo(
    () => arts.data?.find((a) => /_MEP_trj\.xyz$/i.test(a.name) || /_MEP\.allxyz$/i.test(a.name)) ?? null,
    [arts.data],
  );
  const mepContent = ds.useArtifactContent(mepArt?.id ?? null);
  const mepAllArt = useMemo(
    () => arts.data?.find((a) => /_MEP_ALL_trj\.xyz$/i.test(a.name)) ?? null,
    [arts.data],
  );
  const mepAllContent = ds.useArtifactContent(mepAllArt?.id ?? null);
  const tsArt = useMemo(
    () => arts.data?.find((a) => /NEB-CI_converged\.xyz$/i.test(a.name) || /NEB-TS_converged\.xyz$/i.test(a.name)) ?? null,
    [arts.data],
  );
  const tsContent = ds.useArtifactContent(tsArt?.id ?? null);
  const initialPathArt = useMemo(
    () => arts.data?.find((a) => /_initial_path_trj\.xyz$/i.test(a.name)) ?? null,
    [arts.data],
  );
  const initialPathContent = ds.useArtifactContent(initialPathArt?.id ?? null);
  const initialPathFrames = useMemo(
    () => (initialPathContent.data ? parseMultiXYZ(initialPathContent.data.contentText) : []),
    [initialPathContent.data],
  );

  const nebSummary = nebParsed.data;
  const interpIterations = useMemo(
    () => (interpContent.data ? parseNEBInterpIterations(interpContent.data.contentText) : []),
    [interpContent.data],
  );
  const interpData = useMemo(
    () => (interpContent.data ? parseNEBInterp(interpContent.data.contentText) : null),
    [interpContent.data],
  );
  const rawImages = useMemo(
    () =>
      nebSummary?.finalImages.length
        ? nebSummary.finalImages
        : interpData?.images ?? [],
    [nebSummary, interpData],
  );
  const images = useMemo(
    () => mergeNEBXYZ(rawImages, mepContent.data?.contentText),
    [rawImages, mepContent.data],
  );
  const pathsByIteration = useMemo(() => {
    if (!mepAllContent.data) return [];
    const perPath = rawImages.length || interpIterations.at(-1)?.images.length || 0;
    return chunkPathFrames(parseMultiXYZ(mepAllContent.data.contentText), perPath);
  }, [mepAllContent.data, rawImages.length, interpIterations]);

  const usePathSummary = (nebSummary?.finalImages.length ?? 0) > 0;

  const mepChart = useMemo(
    () => buildMepChart(interpData?.interp, images, usePathSummary),
    [interpData, images, usePathSummary],
  );
  const imageChartData = useMemo(
    () => buildImageChartData(images, usePathSummary),
    [images, usePathSummary],
  );
  const barrierChart = useMemo(
    () => buildBarrierChart(nebSummary?.iterations),
    [nebSummary],
  );

  return {
    loading: arts.loading || nebParsed.loading,
    nebSummary,
    interpData,
    images,
    usePathSummary,
    mepChart,
    imageChartData,
    barrierChart,
    tsXyz: tsContent.data?.contentText,
    initialPathFrames,
    interpIterations,
    pathsByIteration,
  };
}
