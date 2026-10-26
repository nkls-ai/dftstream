import { useMemo, useState } from "react";
import { useDataSource } from "../data/DataSource";
import { orgQueryArg, useOrg } from "../auth/OrgContext";
import { parseStructureText } from "../lib/inputBuilder/xyz";
import { StructureSource } from "../lib/inputBuilder/types";
import type { StructureAdopted } from "./InputBuilderStructure";

/**
 * "Start from a previous run's final geometry": experiment → run → the
 * last geometry the run recorded. The charge and multiplicity come with
 * it, because a radical anion that silently becomes a neutral singlet is
 * the exact mistake this feature exists to prevent.
 */
export function InputBuilderRunPicker({ onAdopt }: { onAdopt: (adopted: StructureAdopted) => void }) {
  const ds = useDataSource();
  const org = useOrg();
  const [expId, setExpId] = useState("");
  const [runId, setRunId] = useState("");
  const [errors, setErrors] = useState<string[]>([]);

  const experiments = ds.useExperiments(orgQueryArg(org));
  const runs = ds.useRunsByExperiment(expId || "skip");
  const geoms = ds.useRunGeometries(runId || "skip");

  const run = useMemo(() => (runs.data ?? []).find((r) => r.id === runId) ?? null, [runs.data, runId]);

  // The run's last recorded geometry: for an optimization that is the
  // converged structure, which is the only one worth starting from.
  const final = useMemo(() => {
    const rows = geoms.data ?? [];
    if (rows.length === 0) return null;
    return rows.reduce((best, g) => (g.cycle >= best.cycle ? g : best), rows[0]!);
  }, [geoms.data]);

  function adopt() {
    if (!final || !run) return;
    const label = `${run.name ?? run.id.slice(0, 8)} · cycle ${final.cycle}`;
    const parsed = parseStructureText(final.xyz, StructureSource.Run, label);
    setErrors(parsed.errors);
    if (!parsed.structure) return;
    onAdopt({
      structure: parsed.structure,
      charge: run.charge ?? parsed.charge ?? undefined,
      multiplicity: run.mult ?? parsed.multiplicity ?? undefined,
    });
  }

  return (
    <div className="ib-field">
      <div className="ib-row">
        <select
          value={expId}
          aria-label="Experiment"
          onChange={(e) => {
            setExpId(e.target.value);
            setRunId("");
            setErrors([]);
          }}
        >
          <option value="">Pick an experiment…</option>
          {(experiments.data ?? []).map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        <select
          value={runId}
          disabled={!expId}
          aria-label="Run"
          onChange={(e) => {
            setRunId(e.target.value);
            setErrors([]);
          }}
        >
          <option value="">Pick a run…</option>
          {(runs.data ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {r.name ?? r.id.slice(0, 10)}
              {r.jobType ? ` · ${r.jobType}` : ""} · {r.status}
            </option>
          ))}
        </select>
        <button type="button" className="button" disabled={!final} onClick={adopt}>
          Use final geometry
        </button>
      </div>
      <span className="dim">
        {!expId
          ? "The geometry, charge and multiplicity are taken from the run."
          : runs.capped
            ? "Showing the newest runs of this experiment only."
            : runId && geoms.loading
              ? "Loading geometries…"
              : runId && !final
                ? "This run recorded no geometry — an SP or a run that failed before the first cycle."
                : final
                  ? `Final recorded geometry: cycle ${final.cycle}.`
                  : "The geometry, charge and multiplicity are taken from the run."}
      </span>
      {errors.length > 0 && (
        <ul className="ib-findings">
          {errors.map((e, i) => (
            <li key={i} className="ib-finding error">
              {e}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
