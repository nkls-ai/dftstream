import { describe, expect, test } from "bun:test";
import { methodHeadline, solventLabel } from "./runHeadline";

describe("methodHeadline", () => {
  test("functional/basis with job type", () => {
    expect(
      methodHeadline({ functional: "wB97X-V", basis: "def2-QZVPP", jobType: "SP" }),
    ).toContain("wB97X-V/def2-QZVPP");
  });

  test("functional wins over method", () => {
    expect(methodHeadline({ functional: "B3LYP", method: "DFT" })).toBe("B3LYP");
  });

  test("method without basis", () => {
    expect(methodHeadline({ method: "XTB" })).toBe("XTB");
  });

  test("bare basis still shows", () => {
    expect(methodHeadline({ basis: "def2-SVP" })).toBe("def2-SVP");
  });

  test("nothing set falls back to em dash", () => {
    expect(methodHeadline({})).toBe("—");
  });
});

describe("solventLabel", () => {
  test("model(solvent) when both set", () => {
    expect(solventLabel({ solvent: "water", solventModel: "CPCM" })).toBe("CPCM(water)");
  });
  test("bare solvent without model", () => {
    expect(solventLabel({ solvent: "water" })).toBe("water");
  });
  test("null when no solvent or run", () => {
    expect(solventLabel({})).toBeNull();
    expect(solventLabel(undefined)).toBeNull();
  });
});
