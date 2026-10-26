import type { ReactNode } from "react";
import { SkeletonPanel } from "../components/Skeleton";
import { HARTREE_TO_EV } from "../lib/constants";
import { Callout, CollapsibleSection, InfoTip, StatGrid, StatRow } from "./runDetailUi";
import type { OutProperties } from "./runDetailParsers";
import { AtomTile, BondOrderRow } from "./RunStructureAtomTiles";
import { MODiagram } from "./RunStructureMODiagram";

/** Electronic-properties section of the Structure tab: frontier orbitals,
 *  dipole, partial charges and Mayer bond orders parsed from the .out —
 *  with in-progress / no-artifact / loading placeholder states. */
export function PropertiesPanel({
  properties,
  loading,
  hasOut,
  cubesPresent,
  runFinished,
  hasPerCycle,
}: {
  properties: OutProperties | null;
  loading: boolean;
  hasOut: boolean;
  cubesPresent: boolean;
  runFinished: boolean;
  hasPerCycle: boolean;
}) {
  if (!runFinished) {
    return (
      <PropertiesShell>
        <Callout tone="warn" icon="…">
          <strong>Run still in progress.</strong> HOMO / LUMO energies,
          partial charges, dipole and orbital cube isosurfaces are extracted
          from the final <code>.out</code> + <code>.gbw</code> after the run
          terminates. Re-open this tab once the status flips to{" "}
          <span className="mono">finished</span>.
        </Callout>
      </PropertiesShell>
    );
  }
  if (!hasOut) {
    return (
      <PropertiesShell>
        <div className="dim" style={{ fontSize: 13, lineHeight: 1.5 }}>
          No <code>.out</code> artifact captured - re-run with{" "}
          <code>--artifacts medium</code> (default) or higher to enable
          HOMO/LUMO + partial-charge extraction.
        </div>
      </PropertiesShell>
    );
  }
  if (loading) {
    return (
      <PropertiesShell>
        <SkeletonPanel rows={7} height={240} />
      </PropertiesShell>
    );
  }
  // A .out that finished parsing but yielded nothing is an answer, not a
  // pending state. Folding it into the loading branch (`loading || !properties`)
  // left the skeleton up forever for any run whose output carries no orbital
  // or population analysis — a plain SP without %output, most commonly.
  if (!properties) {
    return (
      <PropertiesShell>
        <div className="dim" style={{ fontSize: 13, lineHeight: 1.5 }}>
          No orbital or population analysis found in this run's <code>.out</code>.
          Add <code>! NormalPrint</code> (or a <code>%output</code> block requesting
          Mulliken/Loewdin/NPA) and re-run to capture them.
        </div>
      </PropertiesShell>
    );
  }
  const { orbitals, orbitalLevels, npa, mulliken, loewdin, bondOrders, dipoleDebye } = properties;
  const charges = npa ?? mulliken ?? loewdin;
  const chargeSource = npa ? "NPA" : mulliken ? "Mulliken" : loewdin ? "Loewdin" : null;
  return (
    <PropertiesShell
      sub={dipoleDebye != null ? `|μ| ${dipoleDebye.toFixed(4)} D` : undefined}
    >
      <div className="split equal">
        <div style={{ display: "grid", gap: 14 }}>
          <div
            className="section-title"
            style={{ marginBottom: 0 }}
          >
            Frontier orbitals
          </div>
          {/* Orbital energies stay at a fixed 5 dp (the ORCA orbital-table convention), not Settings.energyDecimals. */}
          {orbitals ? (
            <div className="fmo-strip">
              <div className="fmo-cell fmo-homo">
                <div className="fmo-label">HOMO</div>
                <div className="fmo-value">{orbitals.homo.toFixed(5)} Eh</div>
                <div className="fmo-conv">
                  {(orbitals.homo * HARTREE_TO_EV).toFixed(3)} eV · MO {orbitals.homoMO}
                </div>
              </div>
              <div className="fmo-cell fmo-lumo">
                <div className="fmo-label">LUMO</div>
                <div className="fmo-value">{orbitals.lumo.toFixed(5)} Eh</div>
                <div className="fmo-conv">
                  {(orbitals.lumo * HARTREE_TO_EV).toFixed(3)} eV · MO {orbitals.lumoMO}
                </div>
              </div>
              <div className="fmo-cell fmo-gap">
                <div className="fmo-label">gap</div>
                <div className="fmo-value">{orbitals.gapEh.toFixed(5)} Eh</div>
                <div className="fmo-conv">{orbitals.gapEv.toFixed(3)} eV</div>
              </div>
            </div>
          ) : (
            <div className="dim" style={{ fontSize: 13 }}>
              No ORBITAL ENERGIES block in this run.
            </div>
          )}
          {orbitalLevels && orbitalLevels.length > 1 && (
            <CollapsibleSection
              title="MO diagram"
              sub={<span>energy levels around the frontier · hover for MO details</span>}
              defaultOpen={false}
            >
              <MODiagram levels={orbitalLevels} />
            </CollapsibleSection>
          )}
          {dipoleDebye != null && (
            <StatGrid>
              <StatRow
                k="Dipole |μ|"
                v={dipoleDebye.toFixed(4)}
                unit="D"
              />
            </StatGrid>
          )}
          <div className="orbital-hint">
            {cubesPresent ? (
              <>
                <span style={{ color: "rgb(var(--teal))" }}>● +</span>{" / "}
                <span style={{ color: "rgb(var(--pink))" }}>● −</span>{" HOMO · "}
                <span style={{ color: "rgb(var(--violet))" }}>● +</span>{" / "}
                <span style={{ color: "rgb(var(--gold))" }}>● −</span>{" LUMO"}
                {hasPerCycle && (
                  <span className="orbital-hint-badge">per-cycle</span>
                )}
                <InfoTip text={cubesPresent && hasPerCycle
                  ? "Pick HOMO / LUMO above the viewer to render isosurfaces. Per-cycle orbitals are active — scrubbing the structure slider swaps to the closest opt cycle's wavefunction."
                  : "Pick HOMO / LUMO above the viewer to render isosurfaces. Only the converged-geometry orbitals are stored. Re-run with --orbitals per-cycle to capture HOMO/LUMO at every opt cycle."
                } />
              </>
            ) : (
              <>
                <span className="dim">No orbital cubes</span>
                <InfoTip text="Orbital lobes (HOMO/LUMO isosurfaces) are auto-generated by DFTStream after the run via orca_plot. If they are missing, check that a .gbw file landed next to your input and that orca_plot is in the same directory as the ORCA binary." />
              </>
            )}
          </div>
        </div>
        <div style={{ display: "grid", gap: 10 }}>
          <div
            className="section-title"
            style={{ marginBottom: 0 }}
          >
            {chargeSource ? `${chargeSource} charges` : "Partial charges"}
          </div>
          {charges ? (
            <div className="atom-grid">
              {charges.map((c) => (
                <AtomTile key={c.idx} c={c} />
              ))}
            </div>
          ) : (
            <div className="dim" style={{ fontSize: 13 }}>
              No partial-charge block in this run.
            </div>
          )}
          {charges && (
            <div
              className="dim"
              style={{ fontSize: 12, lineHeight: 1.45 }}
            >
              Background shade:{" "}
              <span style={{ color: "rgb(var(--blue))" }}>blue −</span> /{" "}
              <span style={{ color: "rgb(var(--pink))" }}>pink +</span>, normalized to
              ±1 e.
            </div>
          )}
        </div>
      </div>
      {bondOrders && bondOrders.length > 0 && (
        <>
          <div className="section-title" style={{ marginTop: 16, marginBottom: 8 }}>
            Mayer bond orders
          </div>
          <div className="bond-order-grid">
            {bondOrders.map((b) => (
              <BondOrderRow key={`${b.atomA}-${b.atomB}`} bond={b} />
            ))}
          </div>
        </>
      )}
    </PropertiesShell>
  );
}

function PropertiesShell({
  sub,
  children,
}: {
  sub?: ReactNode;
  children: ReactNode;
}) {
  return (
    <CollapsibleSection
      title="Electronic properties"
      sub={sub}
      defaultOpen={false}
      storageKey="run.structure.electronicProperties"
    >
      {children}
    </CollapsibleSection>
  );
}
