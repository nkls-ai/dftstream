import { describe, expect, test } from "bun:test";
import type { RunEvent, RunLog } from "../data/types";
import {
  buildUnifiedLog,
  formatFieldValue,
  summarizePayload,
  uniqueEventKinds,
  uniqueLogLevels,
} from "./logEntries";

const events: RunEvent[] = [
  { id: "e1", seq: 1, ts: 200, kind: "scf_cycle", payload: { cycle: 3 } },
  { id: "e2", seq: 2, ts: 400, kind: "run_done", payload: { exitCode: 0 } },
];

const logs: RunLog[] = [
  { id: "l1", ts: 100, level: "info", message: "starting orca" },
  { id: "l2", ts: 300, level: "error", message: "upload failed", fields: { attempt: 2 } },
];

const noFilter = { query: "", kindFilter: null, levelFilter: null, view: "all" as const };

describe("uniqueEventKinds / uniqueLogLevels", () => {
  test("dedupes and sorts", () => {
    expect(
      uniqueEventKinds([
        ...events,
        { id: "e3", seq: 3, ts: 500, kind: "scf_cycle", payload: {} },
      ]),
    ).toEqual(["run_done", "scf_cycle"]);
    expect(uniqueLogLevels(logs)).toEqual(["error", "info"]);
  });

  test("handles undefined input", () => {
    expect(uniqueEventKinds(undefined)).toEqual([]);
    expect(uniqueLogLevels(undefined)).toEqual([]);
  });
});

describe("buildUnifiedLog", () => {
  test("merges events and logs sorted by ts", () => {
    const out = buildUnifiedLog(events, logs, noFilter);
    expect(out.map((e) => e.id)).toEqual(["l1", "e1", "l2", "e2"]);
    expect(out[0]!.type).toBe("log");
    expect(out[1]!.type).toBe("event");
  });

  test("view restricts sources", () => {
    expect(buildUnifiedLog(events, logs, { ...noFilter, view: "events" }).every((e) => e.type === "event")).toBe(true);
    expect(buildUnifiedLog(events, logs, { ...noFilter, view: "wrapper" }).every((e) => e.type === "log")).toBe(true);
  });

  test("kind and level filters apply to their own source only", () => {
    const byKind = buildUnifiedLog(events, logs, { ...noFilter, kindFilter: "run_done" });
    expect(byKind.map((e) => e.id)).toEqual(["l1", "l2", "e2"]);
    const byLevel = buildUnifiedLog(events, logs, { ...noFilter, levelFilter: "error" });
    expect(byLevel.map((e) => e.id)).toEqual(["e1", "l2", "e2"]);
  });

  test("query matches kind, payload, message, level, and fields case-insensitively", () => {
    expect(buildUnifiedLog(events, logs, { ...noFilter, query: "SCF" }).map((e) => e.id)).toEqual(["e1"]);
    expect(buildUnifiedLog(events, logs, { ...noFilter, query: "exitcode" }).map((e) => e.id)).toEqual(["e2"]);
    expect(buildUnifiedLog(events, logs, { ...noFilter, query: "orca" }).map((e) => e.id)).toEqual(["l1"]);
    expect(buildUnifiedLog(events, logs, { ...noFilter, query: "ERROR" }).map((e) => e.id)).toEqual(["l2"]);
    expect(buildUnifiedLog(events, logs, { ...noFilter, query: "attempt" }).map((e) => e.id)).toEqual(["l2"]);
  });

  test("handles undefined sources", () => {
    expect(buildUnifiedLog(undefined, undefined, noFilter)).toEqual([]);
  });
});

describe("formatFieldValue", () => {
  test("null and undefined render an em dash", () => {
    expect(formatFieldValue(null)).toBe("—");
    expect(formatFieldValue(undefined)).toBe("—");
  });

  test("objects render as JSON", () => {
    expect(formatFieldValue({ a: 1 })).toBe('{"a":1}');
  });

  test("long strings truncate to 78 chars with ellipsis", () => {
    const long = "x".repeat(100);
    expect(formatFieldValue(long)).toBe("x".repeat(77) + "…");
    expect(formatFieldValue("x".repeat(80))).toBe("x".repeat(80));
  });

  test("scalars stringify", () => {
    expect(formatFieldValue(42)).toBe("42");
    expect(formatFieldValue(false)).toBe("false");
  });
});

describe("summarizePayload", () => {
  test("empty payload gives empty string", () => {
    expect(summarizePayload({})).toBe("");
  });

  test("priority keys come first, capped at four parts", () => {
    const out = summarizePayload({
      zebra: 1,
      cycle: 2,
      energy: -1.5,
      status: "ok",
      message: "hi",
      name: "n",
    });
    expect(out).toBe("cycle=2  energy=-1.5  status=ok  message=hi");
  });

  test("falls back to remaining keys after priority keys", () => {
    expect(summarizePayload({ zebra: 1, cycle: 2 })).toBe("cycle=2  zebra=1");
  });

  test("skips null values and serializes objects", () => {
    expect(summarizePayload({ cycle: null, extra: { a: 1 } })).toBe('extra={"a":1}');
  });

  test("truncates long output to 237 chars plus ellipsis", () => {
    const out = summarizePayload({ message: "m".repeat(300) });
    expect(out.length).toBe(238);
    expect(out.endsWith("…")).toBe(true);
    expect(out.startsWith("message=mmm")).toBe(true);
  });
});
