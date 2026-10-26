import { expect, test } from "bun:test";
import { runKeywordLine } from "./runKeywordLine";
import type { Run } from "../data/types";

const base = { id: "r1", status: "finished" } as Run;

test("joins keyword tokens", () => {
  expect(
    runKeywordLine({ ...base, keywords: ["B3LYP", "def2-SVP", "Opt", "Freq"] }),
  ).toBe("! B3LYP def2-SVP Opt Freq");
});

test("falls back to first ! line of inputText", () => {
  expect(
    runKeywordLine({
      ...base,
      inputText: "# comment\n  ! HF def2-SVP\n* xyz 0 1\n",
    }),
  ).toBe("! HF def2-SVP");
});

test("keywords win over inputText", () => {
  expect(
    runKeywordLine({ ...base, keywords: ["PBE"], inputText: "! HF\n" }),
  ).toBe("! PBE");
});

test("null when neither exists", () => {
  expect(runKeywordLine(base)).toBeNull();
  expect(runKeywordLine({ ...base, keywords: [], inputText: "* xyz 0 1" })).toBeNull();
});
