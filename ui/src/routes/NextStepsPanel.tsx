import { useMemo, useState } from "react";
import { parseMultiXYZ } from "../components/xyz";
import { useDataSource } from "../data/DataSource";
import type { Run } from "../data/types";
import { cliCommand, FollowupError, GENERATORS, type FollowupKind, type FollowupSource, type GeneratedFile } from "../lib/followup";
import { useSettings } from "../lib/settings";
import { availableFollowups } from "../lib/workflowTree";
import { userErrorMessage } from "../lib/errorReporting";

const RE_FINAL_XYZ = /(?<!_trj)\.xyz$/i;
const RE_IRC_FULL = /_IRC_Full_trj\.xyz$/i;
const RE_TS_XYZ = /NEB-TS_converged\.xyz$/i;

/** Loads the geometry a generator needs from the run's artifacts. */
function useRunGeometryText(runId: string | undefined): { xyz: string | undefined; loading: boolean } {
  const ds = useDataSource();
  const arts = ds.useRunArtifacts(runId ?? "skip");
  const id = useMemo(() => {
    const list = arts.data ?? [];
    // A converged NEB-TS writes its saddle point to its own file; otherwise
    // the run's plain final .xyz is the geometry to carry forward.
    return (list.find((a) => RE_TS_XYZ.test(a.name)) ?? list.find((a) => RE_FINAL_XYZ.test(a.name)))?.id ?? null;
  }, [arts.data]);
  const content = ds.useArtifactContent(runId ? id : null);
  return { xyz: content.data?.contentText, loading: arts.loading || content.loading };
}

function useIrcTrajectory(runId: string | undefined): string | undefined {
  const ds = useDataSource();
  const arts = ds.useRunArtifacts(runId ?? "skip");
  const id = useMemo(() => arts.data?.find((a) => RE_IRC_FULL.test(a.name))?.id ?? null, [arts.data]);
  return ds.useArtifactContent(runId ? id : null).data?.contentText;
}

function download(file: GeneratedFile) {
  const url = URL.createObjectURL(new Blob([file.content], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.click();
  URL.revokeObjectURL(url);
}

function toSource(run: Run, experimentName: string, xyz: string): FollowupSource {
  return {
    runName: run.name ?? run.id,
    experimentName,
    inputText: run.inputText ?? "",
    finalXyz: xyz,
    imaginaryModes: run.imaginaryModes,
    converged: run.converged,
  };
}

export interface NextStepAction {
  kind: FollowupKind;
  /** Runs feeding the generator, in generator order. */
  runs: Run[];
}

/**
 * Generates a follow-up input in the browser and offers it as a download,
 * alongside the equivalent `dftstream next` command. The generated file
 * carries the same provenance comment as the CLI's, so submitting it links
 * the new run to its parent.
 */
export function NextStepAction({ action, experimentName }: { action: NextStepAction; experimentName: string }) {
  const [settings] = useSettings();
  const [files, setFiles] = useState<GeneratedFile[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const spec = GENERATORS[action.kind];
  const primary = action.runs[0];
  const secondary = action.runs[1];
  const primaryGeom = useRunGeometryText(primary?.id);
  const secondaryGeom = useRunGeometryText(secondary?.id);
  const ircFullTrj = useIrcTrajectory(action.kind === "opt-endpoints" ? primary?.id : undefined);

  const cmd = cliCommand(
    action.kind,
    action.runs.map((r) => r.name ?? r.id),
    { method: settings.spMethod, nimages: undefined },
  );

  const generate = () => {
    setError(null);
    setWarnings([]);
    try {
      if (!primary) throw new FollowupError("no source run");
      const sources: FollowupSource[] = [toSource(primary, experimentName, primaryGeom.xyz ?? "")];
      if (spec.sources === 2) {
        if (!secondary) throw new FollowupError("this step needs two runs");
        sources.push(toSource(secondary, experimentName, secondaryGeom.xyz ?? ""));
      }
      const res = spec.generate(sources, { method: settings.spMethod, ircFullTrj });
      setFiles(res.files);
      setWarnings(res.warnings);
    } catch (err) {
      // FollowupError is an expected, user-facing refusal; anything else is a bug worth an incident.
      setError(err instanceof FollowupError ? err.message : userErrorMessage(err, `generate the ${spec.label} input`));
      setFiles(null);
    }
  };

  const waiting = primaryGeom.loading || (spec.sources === 2 && secondaryGeom.loading);

  return (
    <div className="next-step-action">
      <button className="tag-pill run-tag-add" onClick={generate} disabled={waiting}>
        {waiting ? "loading geometry…" : `Generate ${spec.label} input`}
      </button>
      <code className="next-step-cmd" title="Equivalent command on the cluster">{cmd}</code>
      {error && <div className="next-step-error">{error}</div>}
      {warnings.map((w) => (
        <div key={w} className="next-step-warning">△ {w}</div>
      ))}
      {files && (
        <div className="next-step-files">
          {files.map((f) => (
            <div key={f.name} className="next-step-file">
              <span className="mono">{f.name}</span>
              <button className="tag-pill run-tag-add" onClick={() => download(f)}>download</button>
              <button
                className="tag-pill run-tag-add"
                onClick={() => {
                  navigator.clipboard.writeText(f.content).catch((err) => setError(`could not copy: ${err}`));
                }}
              >
                copy
              </button>
              <pre className="next-step-preview">{f.content}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Reads an IRC trajectory's frame count — used by callers for messaging. */
export function ircFrameCount(trj: string | undefined): number {
  return trj ? parseMultiXYZ(trj).length : 0;
}

/**
 * Every follow-up this run can feed, as generate-in-place actions. The
 * scientist picks what to chain — nothing here prescribes an order.
 * neb-ts consumes a second run, so it gets a partner picker.
 */
export function ChainFollowups({
  run,
  partners,
  experimentName,
}: {
  run: Run;
  /** Candidate second runs for two-source generators (same experiment). */
  partners: Run[];
  experimentName: string;
}) {
  const [partnerId, setPartnerId] = useState("");
  const options = availableFollowups(run);
  if (options.length === 0) {
    return <div className="muted" style={{ fontSize: 12 }}>No follow-ups available — the run has not produced a usable geometry yet.</div>;
  }
  const partner = partners.find((p) => p.id === partnerId);
  return (
    <div className="chain-followups">
      {options.map((o) =>
        o.needsPartner ? (
          <div key={o.kind} className="chain-partner">
            <select
              value={partnerId}
              onChange={(e) => setPartnerId(e.target.value)}
              aria-label="second endpoint for the NEB-TS"
            >
              <option value="">NEB-TS with… (pick the other endpoint)</option>
              {partners
                .filter((p) => p.id !== run.id && p.converged === true)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name ?? p.id}
                  </option>
                ))}
            </select>
            {partner && (
              <NextStepAction action={{ kind: o.kind, runs: [run, partner] }} experimentName={experimentName} />
            )}
          </div>
        ) : (
          <NextStepAction key={o.kind} action={{ kind: o.kind, runs: [run] }} experimentName={experimentName} />
        ),
      )}
    </div>
  );
}
