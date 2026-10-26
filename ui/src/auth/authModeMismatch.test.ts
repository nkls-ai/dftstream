import { describe, expect, test } from "bun:test";
import { AuthModeMismatch, authModeMismatch } from "./authModeMismatch";

describe("authModeMismatch", () => {
  test("agreement or unknown backend mode shows nothing", () => {
    expect(authModeMismatch(false, false)).toBe(AuthModeMismatch.NONE);
    expect(authModeMismatch(true, true)).toBe(AuthModeMismatch.NONE);
    expect(authModeMismatch(false, null)).toBe(AuthModeMismatch.NONE);
    expect(authModeMismatch(true, null)).toBe(AuthModeMismatch.NONE);
  });

  test("each disagreement is named", () => {
    expect(authModeMismatch(false, true)).toBe(AuthModeMismatch.UI_WITHOUT_AUTH);
    expect(authModeMismatch(true, false)).toBe(AuthModeMismatch.BACKEND_WITHOUT_AUTH);
  });
});
