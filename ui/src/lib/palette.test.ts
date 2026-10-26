import { expect, test } from "bun:test";
import { HUES, chartColors, hueColor } from "./palette";

test("every hue has a distinct light and dark shade", () => {
  for (const pair of Object.values(HUES)) {
    expect(pair.dark).not.toBe(pair.light);
  }
});

test("hueColor resolves per theme", () => {
  expect(hueColor("gold", "dark")).toBe("#fbbf24");
  expect(hueColor("gold", "light")).toBe("#d97706");
});

test("chartColors keeps the chart chrome and resolves hues for its theme", () => {
  const dark = chartColors("dark");
  const light = chartColors("light");
  expect(dark.grid).toBe("#2b2d31");
  expect(light.grid).toBe("#E5E7EB");
  expect(dark.hue("teal")).toBe(HUES.teal.dark);
  expect(light.hue("teal")).toBe(HUES.teal.light);
});
