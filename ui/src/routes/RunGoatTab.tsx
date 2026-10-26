import { useState } from "react";
import { EnergyChart } from "../components/EnergyChart";
import { StructureViewer } from "../components/StructureViewer";
import { SkeletonPanel } from "../components/Skeleton";
import { useGoatData } from "./goatData";
import {
  goatColumnVisibility,
  goatConformersBelow3Kcal,
  goatHasHeadline,
  goatHasMeta,
  goatRelEnergyText,
  goatSelectedDetails,
  goatTotalPopulation,
} from "./goatDisplay";
import { Headline, HeadlineTile, Section } from "./runDetailUi";
import { RunGoatEnsembleTable } from "./RunGoatEnsembleTable";
import { useEhFormatter, useRelEnergyFormat } from "../lib/useEnergyFormat";

export function GoatTab({ runId }: { runId: string }) {
  const { loading, summary, conformers, chartData, ensemble, globalMinXYZ } = useGoatData(runId);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const fmtEh = useEhFormatter();
  const rel = useRelEnergyFormat();

  const effectiveIndex = conformers.some((c) => c.index === selectedIndex)
    ? selectedIndex
    : conformers[0]?.index ?? 0;
  const selected = conformers.find((c) => c.index === effectiveIndex) ?? conformers[0];

  if (loading) {
    return (
      <div className="tab-shell">
        <SkeletonPanel rows={8} height={360} />
      </div>
    );
  }
  // The .finalensemble.xyz alone is enough for the ensemble table
  // (energies live in the frame comments); only bail when neither the
  // output summary nor the ensemble artifact gave us anything.
  if (!summary && conformers.length === 0) {
    return (
      <div className="empty-state">
        No GOAT summary found in the stored output. Open the Log or Artifacts tab
        to inspect the raw ORCA output.
      </div>
    );
  }

  const population = goatTotalPopulation(conformers);
  const displayXYZ = selected?.xyz ?? globalMinXYZ ?? "";
  const conformersBelow3Kcal = goatConformersBelow3Kcal(summary, conformers);
  const hasHeadline = goatHasHeadline(summary, conformersBelow3Kcal);
  const hasMeta = goatHasMeta(summary, population);
  const columns = goatColumnVisibility(conformers);
  const selectedDetails = goatSelectedDetails(selected, rel);

  return (
    <div className="tab-shell goat-layout">
      {hasHeadline && (
        <Headline>
          {conformersBelow3Kcal != null && (
            <HeadlineTile label="Conformers < 3 kcal/mol" value={conformersBelow3Kcal} />
          )}
          {summary?.lowestEnergyEh != null && (
            <HeadlineTile label="Lowest conformer" value={fmtEh(summary.lowestEnergyEh)} unit="Eh" />
          )}
          {summary?.sconfCalMolK != null && (
            <HeadlineTile label="Sconf" value={summary.sconfCalMolK.toFixed(2)} unit="cal/(mol K)" />
          )}
          {summary?.gconfKcalMol != null && (
            <HeadlineTile label="Gconf" value={summary.gconfKcalMol.toFixed(2)} unit="kcal/mol" />
          )}
        </Headline>
      )}

      {(hasMeta || chartData.length > 0) && (
        <Section title="Search convergence" sub="GOAT global iterations">
          {hasMeta && (
            <div className="goat-meta-strip">
              {summary?.version && <span>mode: <strong>{summary.version}</strong></span>}
              {summary?.finalWorkers != null && <span>workers: <strong>{summary.finalWorkers}</strong></span>}
              {summary?.ensembleTemperatureK != null && <span>T ensemble: <strong>{summary.ensembleTemperatureK.toFixed(2)} K</strong></span>}
              {population > 0 && <span>population accounted: <strong>{population.toFixed(1)}%</strong></span>}
            </div>
          )}
          {chartData.length > 0 && (
            <EnergyChart data={chartData} xLabel="GOAT global iteration" yLabel="Minimum E (Eh)" height={240} />
          )}
        </Section>
      )}

      <div className="goat-main">
        {conformers.length > 0 && (
          <RunGoatEnsembleTable
            runId={runId}
            conformers={conformers}
            columns={columns}
            selectedIndex={selected?.index}
            onSelect={setSelectedIndex}
          />
        )}

        {displayXYZ && (
          <Section
            title={selected ? `Conformer ${selected.index}` : "Structure"}
            sub={selected?.relativeEnergyKcalMol != null ? goatRelEnergyText(selected.relativeEnergyKcalMol, rel) : undefined}
          >
            <div className="goat-view-head">
              {selectedDetails.length > 0 && (
                <div>
                  <div className="dim mono">{selectedDetails.join(" · ")}</div>
                </div>
              )}
              {ensemble && <span className="badge running"><span className="dot" /> {ensemble.name}</span>}
            </div>
            <StructureViewer xyz={displayXYZ} />
          </Section>
        )}
      </div>
    </div>
  );
}
