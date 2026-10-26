import { describe, expect, test } from "vitest";
import { pick, requireNonEmptyName, stripUndefined } from "./util";

describe("pick", () => {
  test("returns only the requested keys", () => {
    const src = { a: 1, b: "two", c: true };
    expect(pick(src, ["a", "c"])).toEqual({ a: 1, c: true });
  });

  test("preserves reference identity of values", () => {
    const inner = { nested: 1 };
    const src = { a: inner, b: 2 };
    expect(pick(src, ["a"]).a).toBe(inner);
  });

  test("empty key list yields empty object", () => {
    expect(pick({ a: 1 }, [])).toEqual({});
  });
});

describe("stripUndefined", () => {
  test("drops undefined entries and keeps the rest", () => {
    expect(
      stripUndefined({ a: 1, b: undefined, c: "x", d: null, e: 0, f: false }),
    ).toEqual({ a: 1, c: "x", d: null, e: 0, f: false });
  });

  test("does not mutate its input", () => {
    const src = { a: 1, b: undefined };
    stripUndefined(src);
    expect("b" in src).toBe(true);
  });

  test("all-undefined input yields empty object", () => {
    expect(stripUndefined({ a: undefined })).toEqual({});
  });
});

describe("requireNonEmptyName", () => {
  test("returns the trimmed name", () => {
    expect(requireNonEmptyName("  benzene opt  ")).toBe("benzene opt");
  });

  test("throws the default message for empty/whitespace input", () => {
    expect(() => requireNonEmptyName("")).toThrow("name cannot be empty");
    expect(() => requireNonEmptyName("   ")).toThrow("name cannot be empty");
  });

  test("uses the label in the message", () => {
    expect(() => requireNonEmptyName(" ", "batch name")).toThrow(
      "batch name cannot be empty",
    );
  });
});
