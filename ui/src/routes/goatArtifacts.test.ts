import { describe, expect, test } from "bun:test";
import { ARTIFACT_KIND, type Artifact } from "../data/types";
import { isFinalGoatEnsemble, isGoatGlobalMinimum } from "./goatArtifacts";

function art(name: string, kind: string = ARTIFACT_KIND.other): Artifact {
  return { id: name, name, path: `/scratch/${name}`, kind, sizeBytes: 1, mtime: 0, hasContent: true };
}

describe("isFinalGoatEnsemble", () => {
  test("matches by artifact kind", () => {
    expect(isFinalGoatEnsemble(art("job.xyz", ARTIFACT_KIND.goatEnsemble))).toBe(true);
  });

  test("matches by .finalensemble.xyz suffix, case-insensitive", () => {
    expect(isFinalGoatEnsemble(art("job.finalensemble.xyz"))).toBe(true);
    expect(isFinalGoatEnsemble(art("JOB.FinalEnsemble.XYZ"))).toBe(true);
  });

  test("excludes intermediate globaliter and confrot ensembles", () => {
    expect(isFinalGoatEnsemble(art("job.globaliter1.finalensemble.xyz"))).toBe(false);
    expect(isFinalGoatEnsemble(art("job.confrot.finalensemble.xyz"))).toBe(false);
    expect(isFinalGoatEnsemble(art("job.globaliter1.xyz", ARTIFACT_KIND.goatEnsemble))).toBe(false);
  });

  test("rejects unrelated artifacts", () => {
    expect(isFinalGoatEnsemble(art("job.out", ARTIFACT_KIND.output))).toBe(false);
  });
});

describe("isGoatGlobalMinimum", () => {
  test("matches by kind or .globalminimum.xyz suffix", () => {
    expect(isGoatGlobalMinimum(art("anything.xyz", ARTIFACT_KIND.goatMinimum))).toBe(true);
    expect(isGoatGlobalMinimum(art("job.globalminimum.xyz"))).toBe(true);
    expect(isGoatGlobalMinimum(art("JOB.GlobalMinimum.XYZ"))).toBe(true);
  });

  test("rejects unrelated artifacts", () => {
    expect(isGoatGlobalMinimum(art("job.finalensemble.xyz"))).toBe(false);
  });
});
