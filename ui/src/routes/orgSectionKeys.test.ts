import { expect, test } from "bun:test";
import { orgSectionKeys } from "./orgSectionKeys";

test("sibling org sections never share a key", () => {
  // Regression: both were keyed by the bare org id.
  const k = orgSectionKeys("org_1");
  expect(k.invite).not.toBe(k.machineTokens);
});

test("keys change with the org, so a switch remounts both sections", () => {
  const a = orgSectionKeys("org_1");
  const b = orgSectionKeys("org_2");
  expect(a.invite).not.toBe(b.invite);
  expect(a.machineTokens).not.toBe(b.machineTokens);
});
