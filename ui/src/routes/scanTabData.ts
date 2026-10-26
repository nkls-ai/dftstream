import { useMemo } from "react";
import { useDataSource } from "../data/DataSource";
import { findCriticalPoints, mergeScanXYZ, parseScanDat, type CriticalPoint, type ScanPoint, type ScanSummary } from "./scan";
import { pickOutArtifact } from "./runDetailArtifacts";
import { useParsedArtifact } from "./useParsedArtifact";

export interface ScanTabData {
  loading: boolean;
  summary: ScanSummary | null;
  points: ScanPoint[];
  crits: CriticalPoint[];
}

// Fetches the scan artifacts (output, trajectory, relaxscanact.dat) and derives
// the merged scan summary, per-point structures, and critical points.
export function useScanTabData(runId: string): ScanTabData {
  const ds = useDataSource();
  const arts = ds.useRunArtifacts(runId);
  const outId = useMemo(() => pickOutArtifact(arts.data), [arts.data]);
  const scanParsed = useParsedArtifact(outId, "scan");
  const trjArt = useMemo(
    () => arts.data?.find((a) => /\.allxyz$/i.test(a.name)) ??
         arts.data?.find((a) => /\.xyzall$/i.test(a.name)) ??
         null,
    [arts.data],
  );
  const trjContent = ds.useArtifactContent(trjArt?.id ?? null);
  const scanDatArt = useMemo(
    () => arts.data?.find((a) => /\.relaxscanact\.dat$/i.test(a.name)) ?? null,
    [arts.data],
  );
  const scanDatContent = ds.useArtifactContent(scanDatArt?.id ?? null);

  const outputSummary = scanParsed.data;
  const datSummary = useMemo(
    () => parseScanDat(scanDatContent.data?.contentText, outputSummary?.coordinates ?? []),
    [scanDatContent.data, outputSummary],
  );
  const summary = datSummary ?? outputSummary;
  const points = useMemo(
    () => mergeScanXYZ(summary, trjContent.data?.contentText),
    [summary, trjContent.data],
  );
  const crits = useMemo(
    () => (summary ? findCriticalPoints(points, summary.dimensions) : []),
    [points, summary],
  );

  const loading = arts.loading || scanParsed.loading || Boolean(scanDatArt && scanDatContent.loading);
  return { loading, summary, points, crits };
}
