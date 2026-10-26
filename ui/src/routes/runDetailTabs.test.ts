import { describe, expect, test } from "bun:test";
import {
  ALL_TABS,
  buildRunTabs,
  isValidTab,
  resolveRunTab,
  runTabFlags,
  type Tab,
} from "./runDetailTabs";

const ids = (tabs: { id: string }[]) => tabs.map((t) => t.id);

describe("isValidTab", () => {
  test("accepts every declared tab id", () => {
    for (const t of ALL_TABS) expect(isValidTab(t)).toBe(true);
  });
  test("rejects unknown ids", () => {
    expect(isValidTab("bogus")).toBe(false);
    expect(isValidTab("")).toBe(false);
  });
});

describe("runTabFlags", () => {
  test("undefined run has no flags", () => {
    const f = runTabFlags(undefined);
    expect(f.hasSpecialTab).toBe(false);
    expect(f.specialDefault).toBe("overview");
  });

  test("OptTS run defaults to the ts tab", () => {
    const f = runTabFlags({ runTypes: ["OPTTS"] });
    expect(f.isTSSearch).toBe(true);
    expect(f.hasSpecialTab).toBe(true);
    expect(f.specialDefault).toBe("ts");
  });

  test("scan detected from inputText directive", () => {
    const f = runTabFlags({ inputText: "! B3LYP\n  Scan\n  B 0 1 = 1.0, 2.0, 10\n  end" });
    expect(f.isScan).toBe(true);
    expect(f.specialDefault).toBe("scan");
  });

  test("GOAT detected from keyword prefix", () => {
    expect(runTabFlags({ keywords: ["GOAT-EXPLORE"] }).isGoat).toBe(true);
    expect(runTabFlags({ keywords: ["OPT"] }).isGoat).toBe(false);
  });

  test("MECP detected from jobType or inputText", () => {
    expect(runTabFlags({ jobType: "MECP" }).isMECP).toBe(true);
    expect(runTabFlags({ inputText: "%mecp ... end" }).isMECP).toBe(true);
  });

  test("NEB and IRC set their special defaults in priority order", () => {
    expect(runTabFlags({ runTypes: ["NEB-TS"] }).specialDefault).toBe("path");
    expect(runTabFlags({ runTypes: ["IRC"] }).specialDefault).toBe("irc");
    // OptTS wins over scan when both present
    expect(runTabFlags({ runTypes: ["OPTTS", "SCAN"] }).specialDefault).toBe("ts");
  });
});

describe("buildRunTabs", () => {
  const none = runTabFlags(undefined);

  test("plain run shows the base tabs", () => {
    expect(ids(buildRunTabs(none, { hideScf: false, hideHardware: false }))).toEqual([
      "overview", "structure", "scf", "hardware", "artifacts", "log",
    ]);
  });

  test("hidden diagnostics are filtered out", () => {
    expect(ids(buildRunTabs(none, { hideScf: true, hideHardware: true }))).toEqual([
      "overview", "structure", "artifacts", "log",
    ]);
  });

  test("special tab replaces Structure and sits right after Overview", () => {
    const f = runTabFlags({ runTypes: ["OPTTS"] });
    expect(ids(buildRunTabs(f, { hideScf: false, hideHardware: false }))).toEqual([
      "overview", "ts", "scf", "hardware", "artifacts", "log",
    ]);
  });

  test("analysis tabs insert after Structure for non-special runs", () => {
    // TDDFT alone is not a "special" tab — structure stays.
    const f = runTabFlags({ runTypes: ["TDDFT"] });
    expect(ids(buildRunTabs(f, { hideScf: false, hideHardware: false }))).toEqual([
      "overview", "structure", "scf", "hardware", "excited", "artifacts", "log",
    ]);
  });

  test("GOAT anchors after Hardware when present", () => {
    const f = runTabFlags({ jobType: "GOAT" });
    expect(ids(buildRunTabs(f, { hideScf: false, hideHardware: false }))).toEqual([
      "overview", "structure", "scf", "hardware", "goat", "artifacts", "log",
    ]);
  });

  test("GOAT falls back to just before Artifacts when Hardware is hidden", () => {
    const f = runTabFlags({ jobType: "GOAT" });
    expect(ids(buildRunTabs(f, { hideScf: true, hideHardware: true }))).toEqual([
      "overview", "structure", "goat", "artifacts", "log",
    ]);
  });

  test("excited then nmr both land before Artifacts, in that order", () => {
    const f = runTabFlags({ runTypes: ["TDDFT", "NMR"] });
    expect(ids(buildRunTabs(f, { hideScf: false, hideHardware: false }))).toEqual([
      "overview", "structure", "scf", "hardware", "excited", "nmr", "artifacts", "log",
    ]);
  });

  test("multiple analysis tabs keep declaration order", () => {
    const f = runTabFlags({ runTypes: ["OPTTS", "IRC"] });
    expect(ids(buildRunTabs(f, { hideScf: false, hideHardware: false }))).toEqual([
      "overview", "ts", "irc", "scf", "hardware", "artifacts", "log",
    ]);
  });
});

describe("TS-search and NEB variant tabs", () => {
  const build = (run: Parameters<typeof runTabFlags>[0]) =>
    ids(buildRunTabs(runTabFlags(run), { hideScf: false, hideHardware: false }));

  test("NEB-TS gets both Path and Transition State tabs, defaulting to Path", () => {
    const f = runTabFlags({ runTypes: ["NEB-TS"] });
    expect(f.isNEB).toBe(true);
    expect(f.isTSSearch).toBe(true);
    expect(f.specialDefault).toBe("path");
    const tabs = build({ runTypes: ["NEB-TS"] });
    expect(tabs).toContain("ts");
    expect(tabs).toContain("path");
  });

  test("plain OptTS still defaults to the TS tab and has no Path tab", () => {
    const f = runTabFlags({ runTypes: ["OPTTS"] });
    expect(f.specialDefault).toBe("ts");
    expect(build({ runTypes: ["OPTTS"] })).not.toContain("path");
  });

  test("ZOOM-NEB variants get the Path tab", () => {
    expect(runTabFlags({ runTypes: ["ZOOM-NEB"] }).isNEB).toBe(true);
    expect(runTabFlags({ runTypes: ["ZOOM-NEB-CI"] }).isNEB).toBe(true);
    const f = runTabFlags({ runTypes: ["ZOOM-NEB-TS"] });
    expect(f.isNEB).toBe(true);
    expect(f.isTSSearch).toBe(true);
  });

  test("legacy rows with only the FAST-NEB-TS keyword still get the Path tab", () => {
    expect(runTabFlags({ runTypes: [], keywords: ["XTB", "FAST-NEB-TS"] }).isNEB).toBe(true);
  });

  test("ScanTS gets Scan (default) plus a display-only TS tab", () => {
    const f = runTabFlags({ runTypes: ["SCANTS"] });
    expect(f.isScan).toBe(true);
    expect(f.isScanTS).toBe(true);
    expect(f.isTSSearch).toBe(false);
    expect(f.specialDefault).toBe("scan");
    expect(build({ runTypes: ["SCANTS"] })).toContain("ts");
  });

  test("NEB-IDPP gets the Path tab (initial-path viewer)", () => {
    expect(runTabFlags({ runTypes: ["NEB-IDPP"] }).isNEB).toBe(true);
  });
});

describe("resolveRunTab", () => {
  const plain: Tab[] = ["overview", "structure", "hardware", "artifacts", "log"];
  const neb: Tab[] = ["overview", "path", "artifacts", "log"];

  test("a visible tab resolves to itself", () => {
    expect(resolveRunTab("hardware", plain, "overview")).toBe("hardware");
    expect(resolveRunTab("path", neb, "path")).toBe("path");
  });

  test("a hidden SCF tab lands on Structure & Energy", () => {
    expect(resolveRunTab("scf", plain, "overview")).toBe("structure");
  });

  test("hidden tabs without a parent fall back to the analysis tab, then Overview", () => {
    expect(resolveRunTab("hardware", neb, "path")).toBe("path");
    expect(resolveRunTab("structure", neb, "path")).toBe("path");
    expect(resolveRunTab("scf", neb, "path")).toBe("path");
    expect(resolveRunTab("goat", plain, "overview")).toBe("overview");
  });

  test("missing or unknown ids use the default", () => {
    expect(resolveRunTab(null, neb, "path")).toBe("path");
    expect(resolveRunTab("bogus", plain, "overview")).toBe("overview");
    expect(resolveRunTab(null, [], "overview")).toBe("overview");
  });
});
