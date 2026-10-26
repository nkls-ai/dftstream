import { describe, expect, test } from "bun:test";
import type { Artifact } from "../data/types";
import { orcaSyntaxModeForArtifact } from "./artifactsSyntaxMode";

function art(partial: Partial<Artifact>): Artifact {
  return {
    id: "a1",
    name: "file",
    path: "/scratch/file",
    kind: "other",
    sizeBytes: 0,
    mtime: 0,
    hasContent: true,
    ...partial,
  };
}

describe("orcaSyntaxModeForArtifact", () => {
  test("input mode from kind or extension", () => {
    expect(orcaSyntaxModeForArtifact(art({ kind: "input", name: "x.dat" }))).toBe("input");
    expect(orcaSyntaxModeForArtifact(art({ name: "job.inp" }))).toBe("input");
    expect(orcaSyntaxModeForArtifact(art({ name: "JOB.IN" }))).toBe("input");
    expect(orcaSyntaxModeForArtifact(art({ name: "job.orca" }))).toBe("input");
  });

  test("output mode from kind or extension", () => {
    expect(orcaSyntaxModeForArtifact(art({ kind: "output", name: "x.dat" }))).toBe("output");
    expect(orcaSyntaxModeForArtifact(art({ kind: "stdout", name: "x.dat" }))).toBe("output");
    expect(orcaSyntaxModeForArtifact(art({ name: "job.out" }))).toBe("output");
    expect(orcaSyntaxModeForArtifact(art({ name: "job.log" }))).toBe("output");
    expect(orcaSyntaxModeForArtifact(art({ name: "job.stdout" }))).toBe("output");
  });

  test("input kind wins over an output-looking name", () => {
    expect(orcaSyntaxModeForArtifact(art({ kind: "input", name: "job.out" }))).toBe("input");
  });

  test("xyz mode from trajectory kinds and extensions", () => {
    for (const kind of ["goat_minimum", "goat_ensemble", "vibmode", "trj"]) {
      expect(orcaSyntaxModeForArtifact(art({ kind, name: "x.dat" }))).toBe("xyz");
    }
    expect(orcaSyntaxModeForArtifact(art({ name: "geom.xyz" }))).toBe("xyz");
    expect(orcaSyntaxModeForArtifact(art({ name: "scan.allxyz" }))).toBe("xyz");
    expect(orcaSyntaxModeForArtifact(art({ name: "job.trj" }))).toBe("xyz");
    expect(orcaSyntaxModeForArtifact(art({ name: "job_trj.xyz" }))).toBe("xyz");
    expect(orcaSyntaxModeForArtifact(art({ name: "job.finalensemble.xyz" }))).toBe("xyz");
    expect(orcaSyntaxModeForArtifact(art({ name: "job.globalminimum.xyz" }))).toBe("xyz");
  });

  test("returns null for everything else", () => {
    expect(orcaSyntaxModeForArtifact(art({ name: "density.cube" }))).toBeNull();
    expect(orcaSyntaxModeForArtifact(art({ name: "job.hess", kind: "other" }))).toBeNull();
    expect(orcaSyntaxModeForArtifact(art({ name: "readme.txt" }))).toBeNull();
  });
});
