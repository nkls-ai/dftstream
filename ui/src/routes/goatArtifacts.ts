import { ARTIFACT_KIND, type Artifact } from "../data/types";

export function isFinalGoatEnsemble(a: Artifact): boolean {
  const name = a.name.toLowerCase();
  return (
    (a.kind === ARTIFACT_KIND.goatEnsemble || name.endsWith(".finalensemble.xyz")) &&
    !name.includes("globaliter") &&
    !name.includes("confrot")
  );
}

export function isGoatGlobalMinimum(a: Artifact): boolean {
  const name = a.name.toLowerCase();
  return a.kind === ARTIFACT_KIND.goatMinimum || name.endsWith(".globalminimum.xyz");
}
