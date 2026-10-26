import type { Frequency, Run } from "../data/types";
import type { OverviewConvergence } from "../lib/convergence";
import type { Thermo } from "./runDetailParsers";
import {
  convergenceToneOf,
  imaginaryModesSummary,
  imaginaryModesTone,
  spinContaminationTone,
} from "./runOverviewData";
import type { SpinContamination } from "./runDetailParsers";
import { MetaIcon } from "./RunOverviewMetaIcon";

/** Headline band of the Overview tab: final energy, convergence verdict,
 *  Gibbs free energy and imaginary-mode count tiles. */
export function RunOverviewSummaryBand({
  r,
  energyDecimals,
  isOptish,
  isOptTS,
  convergence,
  thermo,
  hasFreq,
  imagFreqs,
  spin,
}: {
  r: Run;
  energyDecimals: number;
  isOptish: boolean;
  isOptTS: boolean;
  convergence: OverviewConvergence;
  thermo: Thermo | null;
  hasFreq: boolean;
  imagFreqs: Frequency[];
  spin?: SpinContamination | null;
}) {
  const ed = energyDecimals;
  const convergenceTone = convergenceToneOf(convergence.state);
  // Record fields (wrapper-parsed) fill in before the .out parse lands.
  const spinData: SpinContamination | null =
    spin ?? (r.s2 != null && r.s2Ideal != null ? { s2: r.s2, s2Ideal: r.s2Ideal } : null);
  return (
    <div className="summary-band">
      {r.lastEnergy != null && (
        <div className="summary-band-item">
          <div className="summary-band-label">
            <MetaIcon name="charge" />
            Final single-point energy
          </div>
          <div className="summary-band-value">
            {r.lastEnergy.toFixed(ed)}
            <span className="summary-unit">Eh</span>
          </div>
        </div>
      )}
      <div className="summary-band-item">
        <div className="summary-band-label">
          <MetaIcon name="check" />
          {isOptish ? "Optimization" : "Convergence"}
        </div>
        {convergence.loading ? (
          <div
            className="summary-skeleton summary-skeleton-value"
            aria-label="Loading convergence status"
            role="status"
          />
        ) : (
          <div className={`summary-band-value tone-${convergenceTone}`}>
            {convergence.label}
          </div>
        )}
        {convergence.loading ? (
          <div className="summary-skeleton summary-skeleton-sub" aria-hidden="true" />
        ) : convergence.sub && (
          <div className="summary-band-sub">{convergence.sub}</div>
        )}
      </div>
      {thermo?.gibbsEh != null && (
        <div className="summary-band-item">
          <div className="summary-band-label">Gibbs G</div>
          <div className="summary-band-value" style={{ fontSize: 22 }}>
            {thermo.gibbsEh.toFixed(ed)}
            <span className="summary-unit">Eh</span>
          </div>
          {thermo.gMinusEEh != null && (
            <div className="summary-band-sub">
              G − E(el) {thermo.gMinusEEh >= 0 ? "+" : ""}{thermo.gMinusEEh.toFixed(ed)} Eh
              {thermo.gMinusEKcal != null ? ` (${thermo.gMinusEKcal.toFixed(2)} kcal/mol)` : ""}
            </div>
          )}
        </div>
      )}
      {spinData && (
        <div className="summary-band-item">
          <div className="summary-band-label" title="Expectation value of S² for the final SCF (UHF/UKS). Large deviations from S(S+1) mean the single-determinant description is contaminated by higher spin states.">
            Spin ⟨S²⟩
          </div>
          <div
            className={`summary-band-value tone-${spinContaminationTone(spinData.s2, spinData.s2Ideal)}`}
            style={{ fontSize: 22 }}
          >
            {spinData.s2.toFixed(4)}
          </div>
          <div className="summary-band-sub">
            ideal {spinData.s2Ideal.toFixed(4)} · deviation{" "}
            {Math.abs(spinData.s2 - spinData.s2Ideal).toFixed(4)}
          </div>
        </div>
      )}
      {hasFreq && (
        <div className="summary-band-item">
          <div className="summary-band-label">Imaginary modes</div>
          <div className={`summary-band-value tone-${imaginaryModesTone(imagFreqs.length, isOptTS)}`} style={{ fontSize: 22 }}>
            {imagFreqs.length}
          </div>
          <div className="summary-band-sub">
            {imaginaryModesSummary(imagFreqs)}
          </div>
        </div>
      )}
    </div>
  );
}
