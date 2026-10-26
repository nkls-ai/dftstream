import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { Pathway, Run } from "../data/types";
import { Callout, HeadlineTile, ResizableSplit, Section } from "./runDetailUi";
import { routes } from "../lib/routes";
import { RunStatusBadge } from "../components/RunStatusBadge";
import {
  computeRelativeEnergies,
  computeBarrierHeight,
  computeReactionEnergy,
  interpolateProfile,
  basisEnergyEh,
  checkPathwayConsistency,
  ENERGY_BASIS_LABEL,
  type EnergyBasis,
} from "../lib/pathwayUtils";
import { RoleBadge } from "./pathwayRoles";
import { profilePoint, reactionEnergetics } from "../lib/reactionProfile";
import { PathwayProfileChart } from "./PathwayProfileChart";
import { PathwayPointStructure } from "./PathwayPointStructure";
import { PathwayFormulaProbe } from "./PathwayFormulaProbe";
import { useEhFormatter } from "../lib/useEnergyFormat";

/** Read-only pathway view: headline tiles, energy profile and points table. */
export function PathwayViewer({
  pathway,
  runsById,
  expId,
  selectedRunId,
  onSelectRun,
}: {
  pathway: Pathway;
  runsById: Map<string, Run>;
  expId: string;
  selectedRunId: string | null;
  onSelectRun: (id: string | null) => void;
}) {
  const [basis, setBasis] = useState<EnergyBasis>("E");
  const fmtEh = useEhFormatter();

  const sorted = useMemo(
    () => [...pathway.points].sort((a, b) => a.order - b.order),
    [pathway.points],
  );

  const resolvedPoints = useMemo(() => {
    return sorted.map((pt) => {
      const run = runsById.get(pt.runId);
      return { ...pt, run, name: run?.name ?? "(deleted)", energy: basisEnergyEh(run, basis) };
    });
  }, [sorted, runsById, basis]);

  // H/G exist only for points whose run printed a thermochemistry block
  // (i.e. computed frequencies) — count what each basis would cover so the
  // toggle can be disabled with an explanation instead of blanking the chart.
  const basisCoverage = useMemo(() => {
    const count = (b: EnergyBasis) =>
      sorted.filter((pt) => basisEnergyEh(runsById.get(pt.runId), b) != null).length;
    return { E: count("E"), H: count("H"), G: count("G"), total: sorted.length };
  }, [sorted, runsById]);

  const energies = useMemo(
    () => resolvedPoints.map((p) => p.energy).filter((e): e is number => e != null),
    [resolvedPoints],
  );
  const allHaveEnergy = energies.length === resolvedPoints.length;
  const relKcal = useMemo(
    () => (allHaveEnergy ? computeRelativeEnergies(energies) : []),
    [allHaveEnergy, energies],
  );
  const roles = resolvedPoints.map((p) => p.role);

  // Molecular formula per point run, reported by PathwayFormulaProbe.
  const [formulas, setFormulas] = useState<Record<string, string | null>>({});
  const onFormula = useCallback((runId: string, formula: string | null) => {
    setFormulas((prev) => (prev[runId] === formula ? prev : { ...prev, [runId]: formula }));
  }, []);
  const issue = allHaveEnergy
    ? checkPathwayConsistency(
        resolvedPoints.map((p) => ({ name: p.name, formula: formulas[p.runId] })),
        relKcal,
      )
    : null;
  // Energies of mismatched points are not barriers: show none rather than
  // headline numbers that look authoritative.
  const energiesValid = allHaveEnergy && issue == null;

  const barrier = energiesValid ? computeBarrierHeight(relKcal, roles) : null;
  const rxnEnergy = energiesValid ? computeReactionEnergy(relKcal, roles) : null;

  // Gibbs / SP-refined energetics for the role-tagged points. Refinement is
  // discovered through lineage: a converged child run linked with edge kind
  // "sp" replaces its parent's electronic energy (composite Gibbs).
  const energetics = useMemo(() => {
    const spFor = (runId: string | undefined): Run | undefined => {
      if (!runId) return undefined;
      let best: Run | undefined;
      for (const r of runsById.values()) {
        if (r.parentRunId !== runId || r.parentEdgeKind !== "sp") continue;
        if (r.converged !== true || r.lastEnergy == null) continue;
        if (!best || r.startedAt > best.startedAt) best = r;
      }
      return best;
    };
    const roleRun = (role: string, fromEnd = false) => {
      const pts = fromEnd ? [...resolvedPoints].reverse() : resolvedPoints;
      return pts.find((p) => p.role === role)?.run;
    };
    const reactant = roleRun("reactant");
    const ts = roleRun("ts");
    const product = roleRun("product", true);
    return reactionEnergetics({
      reactant: profilePoint("Reactant", reactant, spFor(reactant?.id)),
      ts: profilePoint("TS", ts, spFor(ts?.id)),
      product: profilePoint("Product", product, spFor(product?.id)),
    });
  }, [resolvedPoints, runsById]);
  const anyRefined = [energetics.reactant, energetics.ts, energetics.product].some((p) => p?.refined);

  const profileData = useMemo(() => {
    if (!allHaveEnergy || resolvedPoints.length < 2) return [];
    const stationaryPts = resolvedPoints.map((p, i) => ({
      x: i,
      y: relKcal[i]!,
      label: p.name,
      role: p.role,
      runId: p.runId,
    }));
    return interpolateProfile(stationaryPts);
  }, [allHaveEnergy, resolvedPoints, relKcal]);

  const activeRunId = selectedRunId ?? resolvedPoints[0]?.runId ?? null;
  const activeRole = resolvedPoints.find((p) => p.runId === activeRunId)?.role;

  const basisLabel = ENERGY_BASIS_LABEL[basis];

  return (
    <>
      {sorted.map((pt) => (
        <PathwayFormulaProbe key={pt.runId} runId={pt.runId} onFormula={onFormula} />
      ))}
      {issue && (
        <div style={{ marginBottom: 12 }}>
          <Callout tone="warn">
            {issue.message} Barriers and reaction energies are not shown.
          </Callout>
        </div>
      )}
      {!allHaveEnergy && (
        <Callout tone="warn">
          {basis === "E"
            ? "Some runs are missing a final energy. The energy profile cannot be rendered until all runs have converged."
            : `Some runs are missing ${basis === "G" ? "a Gibbs free energy" : "an enthalpy"} — only runs with a frequency calculation carry thermochemistry.`}
        </Callout>
      )}

      <div className="chips" style={{ marginBottom: 12 }}>
        {(["E", "H", "G"] as const).map((b) => {
          const covered = basisCoverage[b];
          const complete = covered === basisCoverage.total;
          return (
            <button
              key={b}
              type="button"
              className={"chip " + (b === basis ? "chip-active" : "chip-default")}
              disabled={!complete && b !== basis}
              title={
                complete
                  ? b === "E"
                    ? "Electronic energy"
                    : b === "H"
                      ? "Enthalpy (E + ZPE + thermal corrections)"
                      : "Gibbs free energy (H − TS)"
                  : `${basisCoverage.total - covered} of ${basisCoverage.total} points missing ${b === "H" ? "enthalpy" : "Gibbs energy"} (needs a freq calculation)`
              }
              style={!complete && b !== basis ? { opacity: 0.45, cursor: "not-allowed" } : undefined}
              onClick={() => setBasis(b)}
            >
              {ENERGY_BASIS_LABEL[b]}
            </button>
          );
        })}
      </div>

      <div className="headline" style={{ marginBottom: 16 }}>
        {barrier && (
          <>
            {barrier.forward != null && (
              <HeadlineTile
                label={`Forward barrier (${basisLabel}‡)`}
                value={barrier.forward.toFixed(1)}
                unit="kcal/mol"
                tone="accent"
              />
            )}
            {barrier.reverse != null && (
              <HeadlineTile
                label={`Reverse barrier (${basisLabel}‡)`}
                value={barrier.reverse.toFixed(1)}
                unit="kcal/mol"
              />
            )}
          </>
        )}
        {rxnEnergy != null && (
          <HeadlineTile
            label={`Reaction energy (${basisLabel})`}
            value={rxnEnergy.toFixed(1)}
            unit="kcal/mol"
            tone={rxnEnergy < 0 ? "ok" : "warn"}
          />
        )}
        {energiesValid && anyRefined && energetics.barrierFwdKcal != null && (
          <HeadlineTile
            label="ΔE‡ (SP-refined)"
            value={energetics.barrierFwdKcal.toFixed(1)}
            unit="kcal/mol"
            tone="accent"
          />
        )}
        {energiesValid && energetics.barrierFwdGKcal != null && (
          <HeadlineTile
            label="ΔG‡ forward"
            value={energetics.barrierFwdGKcal.toFixed(1)}
            unit="kcal/mol"
            tone="accent"
          />
        )}
        {energiesValid && energetics.reactionGKcal != null && (
          <HeadlineTile
            label="ΔG reaction"
            value={energetics.reactionGKcal.toFixed(1)}
            unit="kcal/mol"
            tone={energetics.reactionGKcal < 0 ? "ok" : "warn"}
          />
        )}
        <HeadlineTile
          label="Stationary points"
          value={resolvedPoints.length}
        />
      </div>

      {energetics.mixedLevels && (
        <Callout tone="warn">
          Only some stationary points carry a linked high-level single point — the refined numbers mix levels of theory.
        </Callout>
      )}

      {allHaveEnergy && profileData.length > 0 && (
        <ResizableSplit
          defaultLeftPct={60}
          left={
            <div className="card" style={{ padding: 16 }}>
              <h3 style={{ margin: "0 0 8px", fontSize: 13, color: "var(--text-dim)" }}>
                Energy profile
              </h3>
              {issue ? (
                <div className="empty-state">
                  No energy profile: the points are not one chemical system.
                </div>
              ) : (
                <PathwayProfileChart data={profileData} onSelectRun={onSelectRun} basisLabel={basisLabel} />
              )}
            </div>
          }
          right={
            <div className="card pathway-structure-panel">
              <h3 style={{ margin: "0 0 8px", fontSize: 13, color: "var(--text-dim)" }}>
                {activeRole === "ts" ? "TS vibration" : "Structure"}
                {activeRunId ? ` — ${runsById.get(activeRunId)?.name ?? ""}` : ""}
              </h3>
              {activeRunId ? (
                <PathwayPointStructure runId={activeRunId} isTS={activeRole === "ts"} />
              ) : (
                <div className="empty-state">Select a point on the chart.</div>
              )}
            </div>
          }
        />
      )}

      <Section title="Stationary points">
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Run</th>
              <th>Role</th>
              <th>{basis === "E" ? "Energy" : basis} (Eh)</th>
              <th>{basisLabel} (kcal/mol)</th>
              <th>Status</th>
              <th>Imag. modes</th>
            </tr>
          </thead>
          <tbody>
            {resolvedPoints.map((p, i) => (
              <tr
                key={`${p.runId}:${i}`}
                className={activeRunId === p.runId ? "row-active" : ""}
                style={{ cursor: "pointer" }}
                onClick={() => onSelectRun(p.runId)}
              >
                <td className="mono muted">{i + 1}</td>
                <td>
                  {p.run ? (
                    <Link to={routes.run(expId, p.runId)}>{p.name}</Link>
                  ) : (
                    <span className="muted">{p.name}</span>
                  )}
                </td>
                <td><RoleBadge role={p.role} /></td>
                <td className="mono">
                  {fmtEh(p.energy)}
                </td>
                <td className="mono">
                  {energiesValid ? relKcal[i]!.toFixed(1) : "-"}
                </td>
                <td>
                  {p.run ? <RunStatusBadge status={p.run.status} /> : <span className="muted">-</span>}
                </td>
                <td className="mono">
                  {p.run?.imaginaryModes != null ? p.run.imaginaryModes : "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </>
  );
}
