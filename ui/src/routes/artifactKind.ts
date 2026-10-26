import { ARTIFACT_KIND } from "../data/types";

// Display order for the artifact tree — inputs first, spatial data last.
const kindOrder: readonly string[] = [
  ARTIFACT_KIND.input,
  ARTIFACT_KIND.stdout,
  ARTIFACT_KIND.output,
  ARTIFACT_KIND.property,
  ARTIFACT_KIND.cube,
  ARTIFACT_KIND.vibmode,
  ARTIFACT_KIND.trj,
  ARTIFACT_KIND.goatMinimum,
  ARTIFACT_KIND.goatEnsemble,
  ARTIFACT_KIND.other,
];

export function kindRank(kind: string): number {
  const index = kindOrder.indexOf(kind);
  return index < 0 ? 99 : index;
}

export function kindBadge(kind: string): string {
  switch (kind) {
    case ARTIFACT_KIND.input:
      return "input";
    case ARTIFACT_KIND.stdout:
    case ARTIFACT_KIND.output:
      return "output";
    case ARTIFACT_KIND.property:
      return "property";
    case ARTIFACT_KIND.cube:
    case ARTIFACT_KIND.vibmode:
    case ARTIFACT_KIND.trj:
    case ARTIFACT_KIND.goatMinimum:
    case ARTIFACT_KIND.goatEnsemble:
      return "spatial";
    default:
      return "other";
  }
}
