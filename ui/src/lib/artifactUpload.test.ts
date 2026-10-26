import { describe, expect, test } from "bun:test";
import {
  UPLOAD_INLINE_PREVIEW_CHARS,
  classifyUploadedArtifact,
  isSupportedTextUpload,
  prepareArtifactUpload,
} from "./artifactUpload";

describe("artifact upload preparation", () => {
  test("classifies common ORCA artifacts", () => {
    expect(classifyUploadedArtifact("job.inp")).toBe("input");
    expect(classifyUploadedArtifact("job.out")).toBe("output");
    expect(classifyUploadedArtifact("job.stdout.out")).toBe("stdout");
    expect(classifyUploadedArtifact("density.cube")).toBe("cube");
    expect(classifyUploadedArtifact("mode.v001.xyz")).toBe("vibmode");
    expect(classifyUploadedArtifact("opt.allxyz")).toBe("trj");
  });

  test("rejects unsupported binary-looking uploads", () => {
    expect(isSupportedTextUpload("wavefunction.gbw")).toBe(false);
    expect(classifyUploadedArtifact("wavefunction.gbw")).toBe("unsupported");
  });

  test("keeps small artifacts inline", async () => {
    const prepared = await prepareArtifactUpload(fakeFile("density.cube", "cube body", 1234));
    expect(prepared.item.kind).toBe("cube");
    expect(prepared.item.contentText).toBe("cube body");
    expect(prepared.body).toBeUndefined();
    expect(prepared.item.path).toBe("uploaded://density.cube");
  });

  test("keeps a preview inline and carries the full body for storage", async () => {
    const text = "x".repeat(UPLOAD_INLINE_PREVIEW_CHARS + 1007);
    const prepared = await prepareArtifactUpload(fakeFile("big.out", text, 5000));
    expect(prepared.item.contentText).toHaveLength(UPLOAD_INLINE_PREVIEW_CHARS);
    expect(prepared.body).toBe(text);
  });
});

function fakeFile(name: string, text: string, lastModified = 0) {
  return {
    name,
    size: text.length,
    lastModified,
    text: async () => text,
    slice: (start = 0, end = text.length) => ({
      text: async () => text.slice(start, end),
    }),
  };
}
