import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { AuthStartError } from "./AuthStartError";
import { ClerkStartProblem, clerkStartProblem } from "./adapters/clerkStart";

// Regression: a bad or unreachable Clerk publishable key left the page on
// "Loading…" forever. A failed or stalled start now replaces it with an error.
describe("clerkStartProblem", () => {
  test("a failed Clerk start is reported at once", () => {
    expect(clerkStartProblem("error", false)).toBe(ClerkStartProblem.FAILED);
  });

  test("loading is fine until the timeout, then reported", () => {
    expect(clerkStartProblem("loading", false)).toBeNull();
    expect(clerkStartProblem("loading", true)).toBe(ClerkStartProblem.TIMED_OUT);
  });

  test("a start that finishes after the timeout recovers", () => {
    expect(clerkStartProblem("ready", true)).toBeNull();
    expect(clerkStartProblem("degraded", true)).toBeNull();
  });
});

describe("AuthStartError", () => {
  test.each(Object.values(ClerkStartProblem))("%s names both the key config and the network", (problem) => {
    const html = renderToString(<AuthStartError problem={problem} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("DFTSTREAM_CLERK_PUBLISHABLE_KEY");
    expect(html).toContain("cannot reach Clerk");
    expect(html).not.toContain("Loading");
  });
});
