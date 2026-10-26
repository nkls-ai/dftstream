import { useCallback, useMemo } from "react";
import { useSettings } from "./settings";
import { formatEh, relEnergyFormat, type RelEnergyFormat } from "./energyUnits";

// Settings-aware energy display. Kept out of lib/energyUnits.ts so that
// module stays pure: settingsSchema imports it, and a hook there would close
// an import cycle through lib/settings.

/** Absolute-energy formatter honouring Settings.energyDecimals. */
export function useEhFormatter(): (eh: number | null | undefined) => string {
  const [{ energyDecimals }] = useSettings();
  return useCallback(
    (eh: number | null | undefined) => formatEh(eh, energyDecimals),
    [energyDecimals],
  );
}

/** Relative-energy display in the user's Settings.energyUnit. */
export function useRelEnergyFormat(): RelEnergyFormat {
  const [{ energyUnit }] = useSettings();
  return useMemo(() => relEnergyFormat(energyUnit), [energyUnit]);
}
