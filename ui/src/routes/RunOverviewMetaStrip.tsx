import type { Run } from "../data/types";
import { prettyJobType } from "./runDetailArtifacts";
import { hasMethodDetails, methodDisplayValue } from "./runOverviewData";
import { MetaIcon } from "./RunOverviewMetaIcon";

/** Method / molecule metadata strip: method, run type, solvent, charge,
 *  multiplicity. Renders nothing when the run carries no such metadata. */
export function RunOverviewMetaStrip({
  r,
  solventLabel,
}: {
  r: Run;
  solventLabel: string | null;
}) {
  if (!hasMethodDetails(r, solventLabel)) return null;
  return (
    <div className="meta-strip">
      {(r.functional || r.method) && (
        <div className="meta-strip-item">
          <MetaIcon name="method" />
          <div className="meta-strip-text">
            <span className="meta-strip-label">Method</span>
            <span className="meta-strip-value">{methodDisplayValue(r)}</span>
          </div>
        </div>
      )}
      {r.jobType && (
        <div className="meta-strip-item">
          <MetaIcon name="runtype" />
          <div className="meta-strip-text">
            <span className="meta-strip-label">Run type</span>
            <span className="meta-strip-value">{prettyJobType(r.jobType)}</span>
          </div>
        </div>
      )}
      {solventLabel && (
        <div className="meta-strip-item">
          <MetaIcon name="solvent" />
          <div className="meta-strip-text">
            <span className="meta-strip-label">Solvent</span>
            <span className="meta-strip-value">{solventLabel}</span>
          </div>
        </div>
      )}
      {r.charge != null && (
        <div className="meta-strip-item">
          <MetaIcon name="charge" />
          <div className="meta-strip-text">
            <span className="meta-strip-label">Charge</span>
            <span className="meta-strip-value">{r.charge}</span>
          </div>
        </div>
      )}
      {r.mult != null && (
        <div className="meta-strip-item">
          <MetaIcon name="mult" />
          <div className="meta-strip-text">
            <span className="meta-strip-label">Multiplicity</span>
            <span className="meta-strip-value">{r.mult}</span>
          </div>
        </div>
      )}
    </div>
  );
}
