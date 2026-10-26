import { describe, expect, test } from "bun:test";
import { absoluteTimeTitle, formatDurationMs, formatTimeAgo, runDurationLabel, runWallMs } from "./time";
import { formatTimeSetting } from "./settings";

describe("formatDurationMs", () => {
  test("formats seconds", () => {
    expect(formatDurationMs(12_300)).toBe("12s");
  });

  test("formats minutes and seconds", () => {
    expect(formatDurationMs(125_000)).toBe("2m 5s");
  });

  test("formats full and compact hour durations", () => {
    expect(formatDurationMs(3_725_000)).toBe("1h 2m 5s");
    expect(formatDurationMs(3_725_000, { compact: true })).toBe("1h 2m");
  });
});

describe("runWallMs", () => {
  test("prefers ORCA's wallclock over finishedAt-startedAt", () => {
    expect(runWallMs({ wallclockSec: 90, startedAt: 0, finishedAt: 5_000 })).toBe(90_000);
    expect(runWallMs({ startedAt: 1_000, finishedAt: 5_000 })).toBe(4_000);
    expect(runWallMs({ startedAt: 1_000 })).toBeNull();
  });
});

describe("runDurationLabel", () => {
  test("compact duration, running placeholder, or dash", () => {
    expect(runDurationLabel({ wallclockSec: 3_725, startedAt: 0, status: "finished" })).toBe("1h 2m");
    expect(runDurationLabel({ startedAt: 0, finishedAt: 125_000, status: "finished" })).toBe("2m 5s");
    expect(runDurationLabel({ startedAt: 0, status: "running" })).toBe("running…");
    expect(runDurationLabel({ startedAt: 0, status: "pending" })).toBe("-");
  });
});

describe("formatTimeAgo", () => {
  const now = 1_000_000_000;
  test("buckets from just-now to days", () => {
    expect(formatTimeAgo(now - 2_000, now)).toBe("just now");
    expect(formatTimeAgo(now + 5_000, now)).toBe("just now");
    expect(formatTimeAgo(now - 30_000, now)).toBe("30s ago");
    expect(formatTimeAgo(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatTimeAgo(now - (3 * 3600_000 + 12 * 60_000), now)).toBe("3h 12m ago");
    expect(formatTimeAgo(now - 49 * 3600_000, now)).toBe("2d ago");
  });
});

describe("absoluteTimeTitle", () => {
  const ts = Date.UTC(2026, 0, 15, 12, 34, 56);

  test("delegates to the settings formatter for both formats", () => {
    expect(absoluteTimeTitle(ts, "locale")).toBe(formatTimeSetting(ts, "locale"));
    expect(absoluteTimeTitle(ts, "24h")).toBe(formatTimeSetting(ts, "24h"));
  });

  test("24h format is a dd/mm/yyyy 24-hour string", () => {
    expect(absoluteTimeTitle(ts, "24h")).toMatch(/^\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2}$/);
  });

  test("locale format matches the default toLocaleString", () => {
    expect(absoluteTimeTitle(ts, "locale")).toBe(new Date(ts).toLocaleString());
  });
});
