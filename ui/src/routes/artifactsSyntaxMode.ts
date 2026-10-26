import { ARTIFACT_KIND, type Artifact } from "../data/types";
import type { OrcaSyntaxMode } from "../syntax/orca/highlight";

const XYZ_ARTIFACT_KINDS: readonly string[] = [
  ARTIFACT_KIND.goatMinimum,
  ARTIFACT_KIND.goatEnsemble,
  ARTIFACT_KIND.vibmode,
  ARTIFACT_KIND.trj,
];

export function orcaSyntaxModeForArtifact(a: Artifact): OrcaSyntaxMode | null {
  const name = a.name.toLowerCase();
  if (
    a.kind === ARTIFACT_KIND.input ||
    /\.(?:inp|in|orca)$/.test(name)
  ) {
    return "input";
  }
  if (
    a.kind === ARTIFACT_KIND.output ||
    a.kind === ARTIFACT_KIND.stdout ||
    /\.(?:out|log|stdout)$/.test(name)
  ) {
    return "output";
  }
  if (
    XYZ_ARTIFACT_KINDS.includes(a.kind) ||
    /\.(?:xyz|allxyz|trj)$/.test(name) ||
    /(?:_trj|\.finalensemble|\.globalminimum)\.xyz$/.test(name)
  ) {
    return "xyz";
  }
  return null;
}
