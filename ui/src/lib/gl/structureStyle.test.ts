import { describe, expect, test } from "bun:test";
import {
  bgColor,
  chargeToColor,
  lobeColors,
  pickedAtomHighlightRadius,
  sceneConfigKey,
  type SceneConfig,
} from "./structureStyle";

describe("lobeColors", () => {
  test("default set keeps the historical dark colours", () => {
    expect(lobeColors(undefined, "dark")).toEqual({ positive: "#5eead4", negative: "#f472b6" });
    expect(lobeColors("lumo", "dark")).toEqual({ positive: "#a78bfa", negative: "#fbbf24" });
    expect(lobeColors("property", "dark")).toEqual({ positive: "#22d3ee", negative: "#f97316" });
  });

  test("light background gets darker shades", () => {
    const light = lobeColors("occupied", "light");
    expect(light.positive).not.toBe(lobeColors("occupied", "dark").positive);
    expect(light.negative).not.toBe(lobeColors("occupied", "dark").negative);
  });
});

describe("bgColor", () => {
  test("dark and light backgrounds", () => {
    expect(bgColor("dark")).toBe("#1a1b1e");
    expect(bgColor("light")).toBe("#f0f4f8");
  });
});

describe("chargeToColor", () => {
  test("neutral charge is grey", () => {
    expect(chargeToColor(0)).toBe("rgb(153,153,153)");
  });

  test("full positive charge is red-dominant", () => {
    expect(chargeToColor(1)).toBe("rgb(255,89,89)");
  });

  test("full negative charge is blue-dominant", () => {
    expect(chargeToColor(-1)).toBe("rgb(89,128,255)");
  });

  test("clamps beyond ±1", () => {
    expect(chargeToColor(5)).toBe(chargeToColor(1));
    expect(chargeToColor(-5)).toBe(chargeToColor(-1));
  });

  test("saturates at half charge (t = min(1, 2|q|))", () => {
    expect(chargeToColor(0.5)).toBe(chargeToColor(1));
  });
});

describe("pickedAtomHighlightRadius", () => {
  test("spacefill clears the vdW sphere", () => {
    expect(pickedAtomHighlightRadius("H", "spacefill")).toBeCloseTo(1.42, 10);
    expect(pickedAtomHighlightRadius("C", "spacefill")).toBeCloseTo(1.92, 10);
  });

  test("ball-stick scales with vdW radius but floors at 0.52", () => {
    expect(pickedAtomHighlightRadius("C", "ball-stick")).toBeCloseTo(1.7 * 0.28 + 0.18, 10);
    expect(pickedAtomHighlightRadius("H", "ball-stick")).toBeCloseTo(0.52, 10);
  });

  test("thin styles use a fixed radius", () => {
    expect(pickedAtomHighlightRadius("C", "stick")).toBe(0.55);
    expect(pickedAtomHighlightRadius("C", "line")).toBe(0.55);
  });

  test("unknown elements fall back to carbon-ish radius, case-insensitive keys", () => {
    expect(pickedAtomHighlightRadius("Xx", "spacefill")).toBeCloseTo(1.7 + 0.22, 10);
    expect(pickedAtomHighlightRadius("cl", "spacefill")).toBeCloseTo(1.75 + 0.22, 10);
  });
});

describe("sceneConfigKey", () => {
  const base: SceneConfig = {
    style: "ball-stick",
    labels: false,
    surface: "none",
    bg: "dark",
    spinning: false,
    orbKey: "",
    opacity: 0.55,
    colorByCharge: false,
    chargesLen: 0,
  };

  test("stable for identical configs", () => {
    expect(sceneConfigKey(base)).toBe(sceneConfigKey({ ...base }));
  });

  test("every field contributes to the key", () => {
    const variants: SceneConfig[] = [
      { ...base, style: "stick" },
      { ...base, labels: true },
      { ...base, surface: "vdw" },
      { ...base, bg: "light" },
      { ...base, spinning: true },
      { ...base, orbKey: "homo:artifact1" },
      { ...base, opacity: 0.6 },
      { ...base, colorByCharge: true },
      { ...base, chargesLen: 12 },
      { ...base, dipoleKey: "1,0,0:1.5" },
    ];
    const baseKey = sceneConfigKey(base);
    for (const v of variants) {
      expect(sceneConfigKey(v)).not.toBe(baseKey);
    }
  });

  test("matches the legacy inline format", () => {
    expect(sceneConfigKey(base)).toBe("ball-stick|false|none|dark|false||0.55|false|0|");
  });
});
