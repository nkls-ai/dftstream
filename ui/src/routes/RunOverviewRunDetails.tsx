import { useState } from "react";
import type { Run } from "../data/types";
import { formatTimeSetting, useSettings } from "../lib/settings";
import { formatDurationMs } from "../lib/time";
import { MetaIcon } from "./RunOverviewMetaIcon";

/** Collapsible (closed by default) grid of run execution details:
 *  software version, resources, timings, host, exit code. */
export function RunDetailsDisclosure({ r, wallMs }: { r: Run; wallMs: number | null }) {
  const [open, setOpen] = useState(false);
  const [settings] = useSettings();
  const tf = settings.timeFormat;
  return (
    <div className="input-echo">
      <div className="input-echo-head" onClick={() => setOpen((x) => !x)}>
        <span>Run details{r.orcaVersion ? ` · ORCA ${r.orcaVersion}` : ""}{wallMs != null ? ` · ${formatDurationMs(wallMs)}` : ""}</span>
        <span className="input-echo-chevron">{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <div style={{ padding: "12px 14px" }}>
          <div className="detail-grid">
            {r.orcaVersion && (
              <div className="detail-grid-item" data-tooltip="Software version">
                <MetaIcon name="software" />
                <span className="detail-grid-label">Software</span>
                <span className="detail-grid-value">ORCA {r.orcaVersion}</span>
              </div>
            )}
            {r.nprocs != null && (
              <div className="detail-grid-item" data-tooltip="Number of processor cores used">
                <MetaIcon name="cpu" />
                <span className="detail-grid-label">NProcs</span>
                <span className="detail-grid-value">{r.nprocs}</span>
              </div>
            )}
            {r.maxcoreMb != null && (
              <div className="detail-grid-item" data-tooltip="Maximum memory per core">
                <MetaIcon name="memory" />
                <span className="detail-grid-label">MaxCore</span>
                <span className="detail-grid-value">{r.maxcoreMb} MB</span>
              </div>
            )}
            <div className="detail-grid-item" data-tooltip="Run start time">
              <MetaIcon name="play" />
              <span className="detail-grid-label">Started</span>
              <span className="detail-grid-value">{formatTimeSetting(r.startedAt, tf)}</span>
            </div>
            {r.finishedAt && (
              <div className="detail-grid-item" data-tooltip="Run end time">
                <MetaIcon name="check" />
                <span className="detail-grid-label">Finished</span>
                <span className="detail-grid-value">{formatTimeSetting(r.finishedAt, tf)}</span>
              </div>
            )}
            {wallMs != null && (
              <div className="detail-grid-item" data-tooltip={r.wallclockSec != null ? "From ORCA's TOTAL RUN TIME line" : "finishedAt − startedAt"}>
                <MetaIcon name="clock" />
                <span className="detail-grid-label">Wallclock</span>
                <span className="detail-grid-value">{formatDurationMs(wallMs)}</span>
              </div>
            )}
            {r.hostname && (
              <div className="detail-grid-item">
                <MetaIcon name="cpu" />
                <span className="detail-grid-label">Host</span>
                <span className="detail-grid-value">{r.hostname}</span>
              </div>
            )}
            {r.submittedBy && (
              <div className="detail-grid-item">
                <MetaIcon name="check" />
                <span className="detail-grid-label">Submitted by</span>
                <span className="detail-grid-value">{r.submittedBy}</span>
              </div>
            )}
            {r.ncores != null && (
              <div className="detail-grid-item">
                <MetaIcon name="cpu" />
                <span className="detail-grid-label">Cores</span>
                <span className="detail-grid-value">{r.ncores}</span>
              </div>
            )}
            {r.exitCode != null && (
              <div className="detail-grid-item">
                <MetaIcon name="check" />
                <span className="detail-grid-label">Exit code</span>
                <span className="detail-grid-value">{r.exitCode}</span>
              </div>
            )}
            {r.dftstreamVersion && (
              <div className="detail-grid-item" data-tooltip="dftstream wrapper build that tracked this run">
                <MetaIcon name="software" />
                <span className="detail-grid-label">dftstream</span>
                <span className="detail-grid-value mono">{r.dftstreamVersion}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
