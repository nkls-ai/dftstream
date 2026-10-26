import { isTSSearchRun } from "../lib/convergence";

// The single source of truth for run-detail tab ids. The Tab type, URL
// validation and the analysis-styling list all derive from these arrays so
// they cannot drift apart.
export const ALL_TABS = [
  "overview",
  "structure",
  "ts",
  "scf",
  "hardware",
  "goat",
  "scan",
  "path",
  "excited",
  "nmr",
  "irc",
  "mecp",
  "artifacts",
  "log",
] as const;
export type Tab = (typeof ALL_TABS)[number];

/** Tabs that get the accent "analysis" styling in the rail. */
export const ANALYSIS_TAB_IDS: readonly Tab[] = ["structure", "ts", "scan", "path", "irc", "mecp", "excited", "nmr"];

const VALID_TABS = new Set<string>(ALL_TABS);
export function isValidTab(t: string): t is Tab { return VALID_TABS.has(t); }

const BASE_TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "structure", label: "Structure & Energy" },
  { id: "scf", label: "SCF" },
  { id: "hardware", label: "Hardware" },
  { id: "artifacts", label: "Artifacts" },
  { id: "log", label: "Log" },
];

type RunLike = {
  jobType?: string;
  runTypes?: string[];
  keywords?: string[];
  inputText?: string;
};

export function isGoatRun(run: RunLike): boolean {
  return (
    run.jobType === "GOAT" ||
    run.runTypes?.includes("GOAT") === true ||
    run.keywords?.some((kw) => kw.toUpperCase().startsWith("GOAT")) === true
  );
}

/** Every NEB-family run type gets the Path tab (band variants + IDPP interpolation). */
const NEB_RUN_TYPES = ["NEB", "NEB-CI", "NEB-TS", "ZOOM-NEB", "ZOOM-NEB-CI", "ZOOM-NEB-TS", "NEB-IDPP"] as const;

export interface RunTabFlags {
  isGoat: boolean;
  isTDDFT: boolean;
  isNMR: boolean;
  isNEB: boolean;
  isScan: boolean;
  /** Any saddle-point search (OptTS or NEB-TS variants) — gets the Transition State tab. */
  isTSSearch: boolean;
  /**
   * ScanTS: relaxed scan that hands off to an OptTS from the maximum.
   * Gets the TS tab for display, but stays out of the TS-search verdict
   * logic until the parser can attribute the scan→TS phase boundary.
   */
  isScanTS: boolean;
  isIRC: boolean;
  isMECP: boolean;
  hasSpecialTab: boolean;
  /** Tab to auto-select when the run has a special analysis tab. */
  specialDefault: Tab;
}

/** Derive which analysis tabs a run gets from its type/keywords/input. */
export function runTabFlags(run: RunLike | undefined): RunTabFlags {
  const isGoat = run ? isGoatRun(run) : false;
  const isTDDFT = run?.runTypes?.some((t) => t === "TDDFT" || t === "TDA" || t === "CIS" || t === "ESD") ?? false;
  const isNMR = run?.runTypes?.some((t) => t === "NMR" || t === "EPRNMR") ?? false;
  const isNEB = Boolean(
    run?.runTypes?.some((t) => (NEB_RUN_TYPES as readonly string[]).includes(t)) ||
    // Legacy rows classified before the FAST/LOOSE/TIGHT aliases existed
    // carry the raw keyword but an empty run-type list.
    run?.keywords?.some((kw) => /-NEB-TS$/i.test(kw)),
  );
  const isScan = Boolean(
    run?.runTypes?.includes("SCAN") ||
    run?.runTypes?.includes("SCANTS") ||
    run?.jobType === "SCAN" ||
    /^\s*Scan\b/mi.test(run?.inputText ?? ""),
  );
  const isTSSearch = run ? isTSSearchRun(run) : false;
  const isScanTS = run?.runTypes?.includes("SCANTS") ?? false;
  const isIRC = run?.runTypes?.includes("IRC") ?? false;
  const isMECP = Boolean(
    run?.runTypes?.includes("MECP") ||
    run?.jobType === "MECP" ||
    /\bMECP\b/i.test(run?.inputText ?? ""),
  );
  const hasSpecialTab = isTSSearch || isScan || isNEB || isIRC || isMECP;
  // NEB wins the default even for NEB-TS (both tabs exist then): the MEP is
  // the run's primary product; the TS verdict is one click away.
  const specialDefault: Tab = isNEB ? "path" : isTSSearch ? "ts" : isScan ? "scan" : isIRC ? "irc" : isMECP ? "mecp" : "overview";
  return { isGoat, isTDDFT, isNMR, isNEB, isScan, isTSSearch, isScanTS, isIRC, isMECP, hasSpecialTab, specialDefault };
}

/**
 * Assemble the visible tab list for a run: base tabs minus hidden
 * diagnostics, with analysis tabs spliced in at their anchor positions.
 */
export function buildRunTabs(
  flags: RunTabFlags,
  opts: { hideScf: boolean; hideHardware: boolean },
): { id: Tab; label: string }[] {
  let tabs = [...BASE_TABS];
  if (flags.hasSpecialTab) {
    tabs = tabs.filter((t) => t.id !== "structure");
  }
  if (opts.hideScf) {
    tabs = tabs.filter((t) => t.id !== "scf");
  }
  if (opts.hideHardware) {
    tabs = tabs.filter((t) => t.id !== "hardware");
  }
  const analysisTabs: { id: Tab; label: string }[] = [];
  if (flags.isTSSearch || flags.isScanTS) analysisTabs.push({ id: "ts" as const, label: "Transition State" });
  if (flags.isScan) analysisTabs.push({ id: "scan" as const, label: "Scan" });
  if (flags.isNEB) analysisTabs.push({ id: "path" as const, label: "Path" });
  if (flags.isIRC) analysisTabs.push({ id: "irc" as const, label: "IRC" });
  if (flags.isMECP) analysisTabs.push({ id: "mecp" as const, label: "MECP" });
  const insertIdx = flags.hasSpecialTab ? 1 : 2;
  tabs.splice(insertIdx, 0, ...analysisTabs);
  if (flags.isGoat) {
    // Anchor after Hardware when present; imported runs carry no hardware
    // samples (that tab is filtered out above), so fall back to just
    // before Artifacts — the GOAT tab must never silently disappear.
    const hwIdx = tabs.findIndex((t) => t.id === "hardware");
    const anchor = hwIdx >= 0 ? hwIdx + 1 : tabs.findIndex((t) => t.id === "artifacts");
    tabs.splice(anchor < 0 ? tabs.length : anchor, 0, { id: "goat" as const, label: "GOAT" });
  }
  if (flags.isTDDFT) {
    const artIdx = tabs.findIndex((t) => t.id === "artifacts");
    if (artIdx >= 0) tabs.splice(artIdx, 0, { id: "excited" as const, label: "Excited States" });
  }
  if (flags.isNMR) {
    const artIdx = tabs.findIndex((t) => t.id === "artifacts");
    if (artIdx >= 0) tabs.splice(artIdx, 0, { id: "nmr" as const, label: "NMR" });
  }
  return tabs;
}

/**
 * Nearest visible stand-in for a tab the run does not show: the SCF trace and
 * TS verdict fall back to Structure & Energy (energy per cycle), the rest to
 * the run's analysis tab or Overview.
 */
const TAB_FALLBACK: Partial<Record<Tab, Tab>> = {
  scf: "structure",
  ts: "structure",
};

/**
 * The tab a `?tab=` deep link lands on. A requested tab the rail does not
 * show (hidden diagnostics, an analysis tab this run type lacks, a mistyped
 * id) resolves to the closest visible tab, so the rail always marks the tab
 * whose content is on screen.
 */
export function resolveRunTab(
  requested: string | null,
  visible: readonly Tab[],
  specialDefault: Tab,
): Tab {
  const shown = (t: Tab | undefined): t is Tab => t != null && visible.includes(t);
  if (requested && isValidTab(requested)) {
    if (shown(requested)) return requested;
    const alt = TAB_FALLBACK[requested];
    if (shown(alt)) return alt;
  }
  if (shown(specialDefault)) return specialDefault;
  return visible[0] ?? "overview";
}
