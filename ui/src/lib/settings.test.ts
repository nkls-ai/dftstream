import { expect, test } from "bun:test";
import { formatTimeOfDaySetting, formatTimeSetting } from "./settings";

const TS = Date.UTC(2026, 0, 2, 15, 4, 5);

test("24h time of day is HH:MM:SS with no am/pm", () => {
  expect(formatTimeOfDaySetting(TS, "24h")).toMatch(/^\d{2}:\d{2}:\d{2}$/);
});

test("locale time of day matches the browser's own time string", () => {
  expect(formatTimeOfDaySetting(TS, "locale")).toBe(new Date(TS).toLocaleTimeString());
});

test("24h full timestamp carries the date as well", () => {
  expect(formatTimeSetting(TS, "24h")).toMatch(/^\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2}$/);
});
