import { useCallback, useEffect, useRef } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useDataSource } from "../data/DataSource";
import { useSettings } from "../lib/settings";
import { SkeletonDetail } from "../components/Skeleton";
import { GoatTab } from "./RunGoatTab";
import { OverviewTab } from "./RunOverviewTab";
import { StructureTab } from "./RunStructureTab";
import { TSTab } from "./RunTSTab";
import { NEBTab, ScanTab } from "./RunScanNebTabs";
import { ArtifactsTab } from "./RunArtifactsTab";
import { HardwareTab, LogTab, ScfTab } from "./RunDiagnosticsTabs";
import { ExcitedStatesTab } from "./RunExcitedStatesTab";
import { NMRTab } from "./RunNMRTab";
import { IRCTab } from "./RunIRCTab";
import { MECPTab } from "./RunMECPTab";
import { buildRunTabs, resolveRunTab, runTabFlags, type Tab } from "./runDetailTabs";
import { RunDetailHeader } from "./RunDetailHeader";
import { RunTabRail } from "./RunTabRail";
import { NotFoundState } from "../components/NotFoundState";
import { EntityKind } from "../lib/notFoundOrNoAccess";

export function RunDetailCore() {
  const { expId = "", runId = "" } = useParams();
  const ds = useDataSource();
  const [settings] = useSettings();
  const exp = ds.useExperiment(expId);
  const run = ds.useRun(runId);

  const flags = runTabFlags(run.data);
  const { hasSpecialTab, specialDefault } = flags;

  const scfPoints = ds.useRunMetrics(runId, "scf_iter_energy");
  const sysSamples = ds.useRunSysSamples(runId);
  const hasScf = (scfPoints.data ?? []).length > 0;
  const hasHardware = (sysSamples.data ?? []).length > 0;

  const [searchParams, setSearchParams] = useSearchParams();
  const urlTab = searchParams.get("tab");
  const appliedRef = useRef(false);
  const setTab = useCallback((t: Tab) => {
    setSearchParams((prev) => { prev.set("tab", t); return prev; }, { replace: true });
  }, [setSearchParams]);

  useEffect(() => {
    if (appliedRef.current || !run.data || !hasSpecialTab) return;
    if (!urlTab) {
      appliedRef.current = true;
      setTab(specialDefault);
    }
  }, [run.data, hasSpecialTab, specialDefault, urlTab, setTab]);

  if (run.loading) return <SkeletonDetail />;
  if (!run.data) return <NotFoundState entity={EntityKind.RUN} />;

  const tabs = buildRunTabs(flags, {
    // Simple mode hides the SCF tab from the rail, but an explicit
    // ?tab=scf link to a run that has SCF data still gets it.
    hideScf: (!hasScf && !scfPoints.loading) || (settings.simpleMode && urlTab !== "scf"),
    hideHardware: !hasHardware && !sysSamples.loading,
  });
  const tab: Tab = resolveRunTab(urlTab, tabs.map((t) => t.id), specialDefault);

  return (
    <>
      <RunDetailHeader
        expId={expId}
        runId={runId}
        expName={exp.data?.name}
        run={run.data}
      />

      <RunTabRail tabs={tabs} active={tab} onSelect={setTab} />

      {/* Only the active tab is mounted — keep this lazy. */}
      {tab === "overview" && <OverviewTab runId={runId} />}
      {tab === "structure" && <StructureTab runId={runId} />}
      {tab === "ts" && <TSTab runId={runId} />}
      {tab === "scf" && <ScfTab runId={runId} />}
      {tab === "hardware" && <HardwareTab runId={runId} />}
      {tab === "goat" && <GoatTab runId={runId} />}
      {tab === "scan" && <ScanTab runId={runId} />}
      {tab === "path" && <NEBTab runId={runId} />}
      {tab === "mecp" && <MECPTab runId={runId} />}
      {tab === "excited" && <ExcitedStatesTab runId={runId} />}
      {tab === "nmr" && <NMRTab runId={runId} />}
      {tab === "irc" && <IRCTab runId={runId} />}
      {tab === "artifacts" && <ArtifactsTab runId={runId} />}
      {tab === "log" && <LogTab runId={runId} />}
    </>
  );
}
