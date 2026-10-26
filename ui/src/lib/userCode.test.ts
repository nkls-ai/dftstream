import { expect, test } from "bun:test";
import { normalizeUserCode } from "./userCode";

test("canonical code is unchanged", () => {
  expect(normalizeUserCode("BCDF-GHJK")).toBe("BCDF-GHJK");
});

test("lowercase, missing dash and stray whitespace are normalized", () => {
  expect(normalizeUserCode("bcdf-ghjk")).toBe("BCDF-GHJK");
  expect(normalizeUserCode("bcdfghjk")).toBe("BCDF-GHJK");
  expect(normalizeUserCode("  BCDF GHJK \n")).toBe("BCDF-GHJK");
  expect(normalizeUserCode("bc-df-gh-jk")).toBe("BCDF-GHJK");
});

test("wrong length keeps only the cleaned characters (backend rejects it)", () => {
  expect(normalizeUserCode("abc")).toBe("ABC");
  expect(normalizeUserCode("")).toBe("");
});
