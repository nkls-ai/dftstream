import { useMemo } from "react";
import { useDataSource } from "../data/DataSource";
import { buildIRCPath, mergeIRCXYZ, type IRCPathPoint, type IRCSummary } from "./irc";
import { pickOutArtifact } from "./runDetailArtifacts";
import { useParsedArtifact } from "./useParsedArtifact";

export interface IRCData {
  loading: boolean;
  ircSummary: IRCSummary | null;
  path: IRCPathPoint[];
}

// useIRCData locates the run's .out artifact plus any IRC trajectory
// artifacts, parses the IRC summary, and merges trajectory frames into
// the ordered reaction path.
export function useIRCData(runId: string): IRCData {
  const ds = useDataSource();
  const arts = ds.useRunArtifacts(runId);
  const outId = useMemo(() => pickOutArtifact(arts.data), [arts.data]);
  const ircParsed = useParsedArtifact(outId, "irc");

  const fullTrjArt = useMemo(
    () => arts.data?.find((a) => /_IRC_Full_trj\.xyz$/i.test(a.name)) ?? null,
    [arts.data],
  );
  const fwdTrjArt = useMemo(
    () => arts.data?.find((a) => /_IRC_F_trj\.xyz$/i.test(a.name)) ?? null,
    [arts.data],
  );
  const bwdTrjArt = useMemo(
    () => arts.data?.find((a) => /_IRC_B_trj\.xyz$/i.test(a.name)) ?? null,
    [arts.data],
  );
  const fullTrj = ds.useArtifactContent(fullTrjArt?.id ?? null);
  const fwdTrj = ds.useArtifactContent(fwdTrjArt?.id ?? null);
  const bwdTrj = ds.useArtifactContent(bwdTrjArt?.id ?? null);

  const ircSummary = ircParsed.data;

  const rawPath = useMemo(
    () => (ircSummary ? buildIRCPath(ircSummary) : []),
    [ircSummary],
  );

  const path = useMemo(
    () =>
      mergeIRCXYZ(
        rawPath,
        fullTrj.data?.contentText,
        fwdTrj.data?.contentText,
        bwdTrj.data?.contentText,
      ),
    [rawPath, fullTrj.data, fwdTrj.data, bwdTrj.data],
  );

  return { loading: arts.loading || ircParsed.loading, ircSummary, path };
}
