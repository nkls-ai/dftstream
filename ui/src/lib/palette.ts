import type { Theme } from "./settingsSchema";

// Theme-keyed colour tables for anything drawn outside CSS (SVG chart
// attributes, canvas, 3Dmol): CSS variables do not resolve there, so each
// colour is a {dark, light} pair picked for contrast on that theme's
// background. Dark values mirror the index.css accents; light values are
// the matching darker shades from the light theme.

export interface ThemePair {
  dark: string;
  light: string;
}

export const HUES = {
  teal: { dark: "#5eead4", light: "#0d9488" },
  gold: { dark: "#fbbf24", light: "#d97706" },
  violet: { dark: "#a78bfa", light: "#7c3aed" },
  blue: { dark: "#60a5fa", light: "#2563eb" },
  red: { dark: "#f87171", light: "#dc2626" },
  pink: { dark: "#f472b6", light: "#db2777" },
  cyan: { dark: "#22d3ee", light: "#0891b2" },
  orange: { dark: "#f97316", light: "#ea580c" },
} as const satisfies Record<string, ThemePair>;

export type Hue = keyof typeof HUES;

export function hueColor(hue: Hue, theme: Theme): string {
  return HUES[hue][theme];
}

const CHART_BASE = {
  grid: { dark: "#2b2d31", light: "#E5E7EB" },
  axis: { dark: "#6c727e", light: "#6B7280" },
  tooltipBg: { dark: "#1a1b1e", light: "#FFFFFF" },
  tooltipText: { dark: "#d4d7de", light: "#1A2332" },
  line: { dark: "#5eead4", light: "#0D9488" },
  marker: { dark: "#fbbf24", light: "#D97706" },
} as const satisfies Record<string, ThemePair>;

export type ChartColors = { [K in keyof typeof CHART_BASE]: string } & {
  /** A named accent resolved for the theme (annotations, series). */
  hue: (h: Hue) => string;
};

export function chartColors(theme: Theme): ChartColors {
  const base = Object.fromEntries(
    Object.entries(CHART_BASE).map(([k, pair]) => [k, pair[theme]]),
  ) as { [K in keyof typeof CHART_BASE]: string };
  return { ...base, hue: (h) => hueColor(h, theme) };
}
