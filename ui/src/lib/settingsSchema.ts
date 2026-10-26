import { ENERGY_UNIT_OPTIONS, type EnergyUnit } from "./energyUnits";
import { isPlainObject } from "./persistedJson";

// The Settings shape, its defaults, and per-field validation of the
// persisted blob. Kept apart from the store (lib/settings.ts) so it is pure
// and testable without React or localStorage.

export const THEMES = ["dark", "light"] as const;
export type Theme = (typeof THEMES)[number];

export const TIME_FORMATS = ["locale", "24h"] as const;
export type TimeFormat = (typeof TIME_FORMATS)[number];

export const ENERGY_DECIMALS = [6, 8, 10, 12] as const;
export type EnergyDecimals = (typeof ENERGY_DECIMALS)[number];

export const VIEWER_STYLES = ["ball-stick", "stick", "line", "spacefill"] as const;
export type ViewerStyle = (typeof VIEWER_STYLES)[number];

export const EXPERIMENT_PAGE_SIZES = [10, 50, 100] as const;
export type ExperimentPageSize = (typeof EXPERIMENT_PAGE_SIZES)[number];

const ENERGY_UNITS: readonly EnergyUnit[] = ENERGY_UNIT_OPTIONS.map((o) => o.value);

export interface Settings {
  theme: Theme;
  energyDecimals: EnergyDecimals;
  /** Unit for relative energies (ΔE/ΔG). Absolute energies stay in Eh. */
  energyUnit: EnergyUnit;
  timeFormat: TimeFormat;
  viewerStyle: ViewerStyle;
  viewerSpin: boolean;
  sidebarCollapsed: boolean;
  simpleMode: boolean;
  experimentPageSize: ExperimentPageSize;
  desktopNotifications: boolean;
  irScaleFactors: Record<string, number>;
  /** Default '!' keyword line for generated high-level single points
   *  (mirrors the wrapper config's spMethod). */
  spMethod: string;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  theme: "dark",
  energyDecimals: 8,
  // Relative energies (barriers, reaction energies, profiles) are read in
  // kcal/mol by convention; absolute energies are always Eh regardless.
  energyUnit: "kcal",
  timeFormat: "locale",
  viewerStyle: "ball-stick",
  viewerSpin: false,
  sidebarCollapsed: false,
  simpleMode: true,
  experimentPageSize: 50,
  desktopNotifications: false,
  spMethod: "DLPNO-CCSD(T) cc-pVTZ cc-pVTZ/C TightSCF",
  irScaleFactors: {},
};

function oneOf<T>(allowed: readonly T[], v: unknown, fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function scaleFactors(v: unknown): Record<string, number> {
  if (!isPlainObject(v)) return {};
  const out: Record<string, number> = {};
  for (const [k, f] of Object.entries(v)) {
    if (typeof f === "number" && Number.isFinite(f)) out[k] = f;
  }
  return out;
}

/**
 * Settings from a persisted (untrusted) blob: every field is validated on
 * its own and falls back to its default, so one stale or hand-edited field
 * can never smuggle a wrong type into the app or wipe the other settings.
 */
export function parseSettings(raw: unknown): Settings {
  const d = DEFAULT_SETTINGS;
  if (!isPlainObject(raw)) return { ...d, irScaleFactors: {} };
  return {
    theme: oneOf(THEMES, raw.theme, d.theme),
    energyDecimals: oneOf(ENERGY_DECIMALS, raw.energyDecimals, d.energyDecimals),
    energyUnit: oneOf(ENERGY_UNITS, raw.energyUnit, d.energyUnit),
    timeFormat: oneOf(TIME_FORMATS, raw.timeFormat, d.timeFormat),
    viewerStyle: oneOf(VIEWER_STYLES, raw.viewerStyle, d.viewerStyle),
    viewerSpin: bool(raw.viewerSpin, d.viewerSpin),
    sidebarCollapsed: bool(raw.sidebarCollapsed, d.sidebarCollapsed),
    simpleMode: bool(raw.simpleMode, d.simpleMode),
    experimentPageSize: oneOf(EXPERIMENT_PAGE_SIZES, raw.experimentPageSize, d.experimentPageSize),
    desktopNotifications: bool(raw.desktopNotifications, d.desktopNotifications),
    irScaleFactors: scaleFactors(raw.irScaleFactors),
    spMethod: typeof raw.spMethod === "string" ? raw.spMethod : d.spMethod,
  };
}
