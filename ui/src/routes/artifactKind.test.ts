import { describe, expect, test } from "bun:test";
import { kindBadge, kindRank } from "./artifactKind";

describe("artifact kind helpers", () => {
  test("orders renderable generated artifacts before other artifacts", () => {
    expect(kindRank("cube")).toBeLessThan(kindRank("other"));
    expect(kindRank("vibmode")).toBeLessThan(kindRank("other"));
    expect(kindRank("goat_ensemble")).toBeLessThan(kindRank("other"));
    expect(kindRank("unknown")).toBe(99);
  });

  test("does not render generated artifacts with failure styling", () => {
    expect(kindBadge("cube")).toBe("spatial");
    expect(kindBadge("vibmode")).toBe("spatial");
    expect(kindBadge("trj")).toBe("spatial");
    expect(kindBadge("goat_minimum")).toBe("spatial");
    expect(kindBadge("goat_ensemble")).toBe("spatial");
    expect(kindBadge("unknown")).toBe("other");
  });
});
