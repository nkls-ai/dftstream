import { useMemo } from "react";
import { useSettings } from "./settings";
import { chartColors, type ChartColors } from "./palette";

export type { ChartColors, Hue } from "./palette";

/** Chart chrome + named accents for the active theme (see lib/palette.ts). */
export function useChartColors(): ChartColors {
  const [{ theme }] = useSettings();
  return useMemo(() => chartColors(theme), [theme]);
}
