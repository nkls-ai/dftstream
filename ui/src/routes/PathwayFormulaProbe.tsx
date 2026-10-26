import { useEffect } from "react";
import { useDataSource } from "../data/DataSource";
import { xyzFormula } from "../lib/pathwayUtils";

/**
 * Renders nothing; reports the molecular formula of one pathway point's run
 * (from its stored geometry) so PathwayViewer can check that every point is
 * the same chemical system. null = the run has no geometry to read.
 */
export function PathwayFormulaProbe({
  runId,
  onFormula,
}: {
  runId: string;
  onFormula: (runId: string, formula: string | null) => void;
}) {
  const ds = useDataSource();
  const geoms = ds.useRunGeometries(runId);
  // Every geometry of a run has the same atoms; the first is enough.
  const formula = geoms.loading ? undefined : xyzFormula(geoms.data?.[0]?.xyz);
  useEffect(() => {
    if (formula !== undefined) onFormula(runId, formula);
  }, [runId, formula, onFormula]);
  return null;
}
