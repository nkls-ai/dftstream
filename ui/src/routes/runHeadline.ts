import { prettyJobType } from "./runDetailArtifacts";

// methodHeadline builds a short human-readable "method line" for the
// page header: e.g. "r2SCAN-3c · OPT+Freq", "wB97X-V/def2-QZVPP · SP",
// "XTB · GOAT". Falls back to the bare jobType if nothing usable is set.
export function methodHeadline(run: {
  method?: string;
  functional?: string;
  basis?: string;
  jobType?: string;
}): string {
  const parts: string[] = [];
  if (run.functional) {
    parts.push(run.basis ? `${run.functional}/${run.basis}` : run.functional);
  } else if (run.method) {
    parts.push(run.basis ? `${run.method}/${run.basis}` : run.method);
  } else if (run.basis) {
    parts.push(run.basis);
  }
  if (run.jobType) parts.push(prettyJobType(run.jobType));
  return parts.length > 0 ? parts.join(" · ") : "—";
}

/** "CPCM(water)"-style label, or null when the run has no solvent. */
export function solventLabel(run: { solvent?: string; solventModel?: string } | undefined): string | null {
  return run?.solvent
    ? run.solventModel
      ? `${run.solventModel}(${run.solvent})`
      : run.solvent
    : null;
}
