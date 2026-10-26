import { expect, test } from "bun:test";
import { normalizeRun } from "./normalize";

type RunRow = Parameters<typeof normalizeRun>[0];

function row(fields: Partial<RunRow>): RunRow {
  return { _id: "r1", _creationTime: 0, experimentId: "e1", name: "run", status: "finished", ...fields } as RunRow;
}

test("a run tracked before the rename shows its wrapper version", () => {
  const run = normalizeRun(row({ orcastreamVersion: "v0.6.0" }));
  expect(run.dftstreamVersion).toBe("v0.6.0");
  expect("orcastreamVersion" in run).toBe(false);
});

test("the current field wins over the pre-rename one", () => {
  expect(normalizeRun(row({ dftstreamVersion: "v1.0.0", orcastreamVersion: "v0.6.0" })).dftstreamVersion).toBe("v1.0.0");
});

test("no version field stays absent", () => {
  expect("dftstreamVersion" in normalizeRun(row({}))).toBe(false);
});
