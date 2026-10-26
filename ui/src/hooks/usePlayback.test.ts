import { test, expect, describe } from "bun:test";

describe("usePlayback rAF-based animation", () => {
  test("rAF-based loop uses refs for speed/max to avoid effect re-creation", () => {
    // Verify the hook source uses requestAnimationFrame, not setInterval
    const hookSource = require("fs").readFileSync(
      require("path").join(__dirname, "usePlayback.ts"),
      "utf8",
    );
    expect(hookSource).toContain("requestAnimationFrame");
    expect(hookSource).not.toContain("setInterval");
  });

  test("speed and max accessed via refs inside rAF loop", () => {
    const hookSource = require("fs").readFileSync(
      require("path").join(__dirname, "usePlayback.ts"),
      "utf8",
    );
    expect(hookSource).toContain("speedRef.current");
    expect(hookSource).toContain("maxRef.current");
  });
});

describe("usePlayback follow mode", () => {
  const { staysFollowing } = require("./usePlayback");

  test("landing on the last frame keeps following new frames", () => {
    expect(staysFollowing(4, 4)).toBe(true);
  });

  test("scrubbing back detaches, so new frames do not yank the view", () => {
    expect(staysFollowing(2, 4)).toBe(false);
    expect(staysFollowing(0, 4)).toBe(false);
  });
});
