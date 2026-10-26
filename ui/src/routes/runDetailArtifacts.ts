import { ARTIFACT_KIND } from "../data/types";
import { prettyRunType } from "../lib/runTypeLabels";

export function pickOutArtifact(
  arts: { id: string; kind: string; name: string; sizeBytes: number }[] | undefined,
): string | null {
  if (!arts || arts.length === 0) return null;
  const outputs = arts.filter((a) => a.kind === ARTIFACT_KIND.output);
  const dotOut = outputs.find((a) => /\.out$/i.test(a.name));
  if (dotOut) return dotOut.id;
  if (outputs.length > 0) {
    const biggest = [...outputs].sort((a, b) => b.sizeBytes - a.sizeBytes)[0]!;
    return biggest.id;
  }
  return arts.find((a) => a.kind === ARTIFACT_KIND.stdout)?.id ?? null;
}

export function displayBasename(name: string): string {
  const slash = name.lastIndexOf("/");
  return slash >= 0 ? name.slice(slash + 1) : name;
}

export function prettyJobType(jt: string): string {
  return prettyRunType(jt);
}
