import { describe, expect, test } from "bun:test";
import type { Run } from "../data/types";
import {
  batchConvergence,
  hasExplicitFreq,
  isActiveStatus,
  isMinimizationRun,
  isOptTSRun,
  isOptimizationRun,
  isTSSearchRun,
  overviewConvergence,
  runsTableConvergence,
  stationaryPointVerdict,
  tsVerdict,
} from "./convergence";

function run(partial: Partial<Run>): Run {
  return { id: "r1", experimentId: "e1", status: "finished", startedAt: 0, ...partial };
}

describe("run-type helpers", () => {
  test("classifies OPT / COPT / OPTTS families", () => {
    expect(isMinimizationRun(run({ runTypes: ["OPT"] }))).toBe(true);
    expect(isMinimizationRun(run({ runTypes: ["COPT"] }))).toBe(true);
    expect(isMinimizationRun(run({ runTypes: ["OPTTS"] }))).toBe(false);
    expect(isOptTSRun(run({ runTypes: ["OPTTS", "FREQ"] }))).toBe(true);
    expect(isOptimizationRun(run({ runTypes: ["OPTTS"] }))).toBe(true);
    expect(isOptimizationRun(run({ runTypes: ["SP"] }))).toBe(false);
    expect(isOptimizationRun(run({}))).toBe(false);
  });

  test("detects explicit frequency job keywords", () => {
    expect(hasExplicitFreq(run({ runTypes: ["OPT", "FREQ"] }))).toBe(true);
    expect(hasExplicitFreq(run({ runTypes: ["NUMFREQ"] }))).toBe(true);
    expect(hasExplicitFreq(run({ runTypes: ["OPT"] }))).toBe(false);
  });

  test("isActiveStatus", () => {
    expect(isActiveStatus("pending")).toBe(true);
    expect(isActiveStatus("running")).toBe(true);
    expect(isActiveStatus("finished")).toBe(false);
    expect(isActiveStatus("failed")).toBe(false);
  });
});

describe("runsTableConvergence", () => {
  test("failed and active runs", () => {
    expect(runsTableConvergence(run({ status: "failed" }))).toEqual({ tone: "failed", label: "Failed" });
    expect(runsTableConvergence(run({ status: "running", converged: true }))).toEqual({ tone: "running", label: "running" });
  });

  test("converged OptTS with exactly one imaginary mode is a valid TS", () => {
    const b = runsTableConvergence(run({ converged: true, runTypes: ["OPTTS"], imaginaryModes: 1 }));
    expect(b).toMatchObject({ tone: "ok", label: "Converged · valid TS" });
  });

  test("converged OptTS with wrong imaginary count warns", () => {
    const b = runsTableConvergence(run({ converged: true, runTypes: ["OPTTS"], imaginaryModes: 3 }));
    expect(b).toMatchObject({ tone: "warn", label: "Converged · 3 imag" });
  });

  test("converged minimum with imaginary modes warns", () => {
    expect(runsTableConvergence(run({ converged: true, imaginaryModes: 0 }))).toMatchObject({ tone: "ok", label: "Converged" });
    expect(runsTableConvergence(run({ converged: true, imaginaryModes: 2 }))).toMatchObject({ tone: "warn", label: "Converged · 2 imag" });
    expect(runsTableConvergence(run({ converged: true }))).toMatchObject({ tone: "ok", label: "Converged" });
  });

  test("unconverged non-opt finished run reads Finished", () => {
    expect(runsTableConvergence(run({ converged: false, runTypes: ["OPT"] }))).toMatchObject({ tone: "noconv" });
    expect(runsTableConvergence(run({ converged: false, runTypes: ["SP"] }))).toMatchObject({ tone: "ok", label: "Finished" });
  });

  test("finished without converged field reads Finished", () => {
    // No run type: nothing claims an optimizer ran, so a normal exit is all
    // there is to report.
    expect(runsTableConvergence(run({}))).toMatchObject({ tone: "ok", label: "Finished" });
    expect(runsTableConvergence(run({ runTypes: ["SP"] }))).toMatchObject({ tone: "ok", label: "Finished" });
  });

  // ORCA prints ****ORCA TERMINATED NORMALLY**** whether or not the optimizer
  // converged. A convergence-gated run with no recorded verdict used to render
  // a green "Finished" badge, i.e. the UI called an unknown outcome a success.
  test("finished opt with no convergence verdict never claims success", () => {
    for (const runTypes of [["OPT"], ["COPT"], ["OPTTS"], ["NEB-TS"], ["NEB"], ["ZOOM-NEB-CI"]]) {
      const badge = runsTableConvergence(run({ status: "finished", runTypes }));
      expect(badge?.tone).toBe("warn");
      expect(badge?.label).toBe("Finished · convergence unknown");
      expect(badge?.title).toContain("TERMINATED NORMALLY");
    }
  });

  test("an explicit converged verdict still wins over the unknown badge", () => {
    expect(runsTableConvergence(run({ status: "finished", converged: true, runTypes: ["OPT"] })))
      .toMatchObject({ tone: "ok" });
    expect(runsTableConvergence(run({ status: "finished", converged: false, runTypes: ["OPT"] })))
      .toMatchObject({ tone: "noconv" });
  });
});

describe("batchConvergence", () => {
  test("converged flag wins over running status (batch precedence)", () => {
    expect(batchConvergence(run({ status: "running", converged: true }))).toMatchObject({ tone: "ok", label: "Converged" });
  });

  test("null for finished runs without a converged flag", () => {
    expect(batchConvergence(run({}))).toBeNull();
    expect(batchConvergence(run({ status: "pending" }))).toMatchObject({ tone: "running", label: "pending" });
  });
});

const outIdle = { loading: false, hasOut: false, text: undefined };

describe("overviewConvergence", () => {
  test("prefers the DB field", () => {
    expect(overviewConvergence(run({ converged: true }), true, outIdle)).toMatchObject({ state: "ok", label: "Converged", sub: "geometry optimized" });
    expect(overviewConvergence(run({ converged: false }), true, outIdle)).toMatchObject({ state: "bad", label: "Not converged" });
    expect(overviewConvergence(run({ converged: false }), false, outIdle)).toMatchObject({ state: "ok", label: "Finished" });
  });

  test("failed / running short-circuit", () => {
    expect(overviewConvergence(run({ status: "failed", exitCode: 137 }), false, outIdle)).toMatchObject({ state: "bad", sub: "exit 137" });
    expect(overviewConvergence(run({ status: "running" }), false, outIdle)).toMatchObject({ state: "pending", label: "Running" });
  });

  test("falls back to parsing the .out for legacy runs", () => {
    const out = { loading: false, hasOut: true, text: "...\nTHE OPTIMIZATION HAS CONVERGED\n..." };
    expect(overviewConvergence(run({}), true, out)).toMatchObject({ state: "ok", label: "Converged" });
    const scf = { loading: false, hasOut: true, text: "SCF CONVERGED AFTER  12 CYCLES" };
    expect(overviewConvergence(run({}), false, scf)).toMatchObject({ state: "ok", sub: "SCF in 12 iters" });
    const term = { loading: false, hasOut: true, text: "ORCA TERMINATED NORMALLY" };
    expect(overviewConvergence(run({}), true, term)).toMatchObject({ state: "bad", label: "Not converged" });
    expect(overviewConvergence(run({}), false, term)).toMatchObject({ state: "ok", label: "Finished" });
  });

  test("reports loading / missing .out states", () => {
    expect(overviewConvergence(run({}), false, { loading: true, hasOut: false, text: undefined })).toMatchObject({ loading: true });
    expect(overviewConvergence(run({}), false, outIdle)).toMatchObject({ label: "Unknown", sub: ".out not captured" });
  });
});

describe("tsVerdict", () => {
  test("gates on run status and optimizer convergence", () => {
    expect(tsVerdict(run({ status: "running" }), 5, [-450]).label).toBe("In progress");
    expect(tsVerdict(run({ status: "failed" }), 5, [-450]).label).toBe("Run failed");
    expect(tsVerdict(run({ converged: false }), 5, [-450]).label).toBe("Opt not converged");
  });

  test("judges the imaginary-mode count once converged", () => {
    expect(tsVerdict(run({ converged: true }), 0, [])).toMatchObject({ tone: "warn", label: "No frequencies" });
    expect(tsVerdict(run({ converged: true }), 5, [-452.3])).toMatchObject({ tone: "ok", label: "Valid TS" });
    expect(tsVerdict(run({ converged: true }), 5, [-452.3]).detail).toContain("-452 cm⁻¹");
    expect(tsVerdict(run({ converged: true }), 5, [])).toMatchObject({ tone: "bad", label: "Not a TS" });
    expect(tsVerdict(run({ converged: true }), 5, [-450, -120])).toMatchObject({ tone: "warn", label: "Higher-order saddle" });
  });
});

describe("stationaryPointVerdict", () => {
  test("silent when the spectrum matches the job type", () => {
    expect(stationaryPointVerdict(run({ runTypes: ["OPTTS"] }), true, [-450])).toBeNull();
    expect(stationaryPointVerdict(run({ runTypes: ["OPT"] }), true, [])).toBeNull();
    expect(stationaryPointVerdict(run({ runTypes: ["SP"] }), true, [-450])).toBeNull();
    expect(stationaryPointVerdict(run({ runTypes: ["OPT"] }), false, [-450])).toBeNull();
  });

  test("flags a minimum masquerading as a TS and vice versa", () => {
    const noImag = stationaryPointVerdict(run({ runTypes: ["OPTTS"] }), true, []);
    expect(noImag).toMatchObject({ tone: "bad" });
    expect(noImag!.text).toContain("minimum, not a transition state");

    const contaminated = stationaryPointVerdict(run({ runTypes: ["OPTTS"] }), true, [-450, -100]);
    expect(contaminated).toMatchObject({ tone: "warn" });
    expect(contaminated!.text).toContain("2 imaginary modes");

    const badMin = stationaryPointVerdict(run({ runTypes: ["OPT"] }), true, [-90]);
    expect(badMin).toMatchObject({ tone: "warn" });
    expect(badMin!.text).toContain("not a true minimum");
  });
});

describe("NEB-TS verdict matrix", () => {
  const nebts = (extra: object) => ({ runTypes: ["NEB-TS"], status: "finished" as const, ...extra });

  test("converged NEB-TS with 1 imag is a valid TS", () => {
    const b = runsTableConvergence(nebts({ converged: true, imaginaryModes: 1 }));
    expect(b?.tone).toBe("ok");
    expect(b?.label).toBe("Converged · valid TS");
  });

  test("converged NEB-TS with wrong imag count warns", () => {
    expect(runsTableConvergence(nebts({ converged: true, imaginaryModes: 2 }))?.tone).toBe("warn");
    expect(runsTableConvergence(nebts({ converged: true, imaginaryModes: 0 }))?.tone).toBe("warn");
  });

  test("unconverged NEB-TS shows Not converged (opt semantics)", () => {
    const b = runsTableConvergence(nebts({ converged: false }));
    expect(b?.tone).toBe("noconv");
    expect(b?.label).toBe("Not converged");
  });

  test("ZOOM-NEB-TS follows the same rules", () => {
    const b = runsTableConvergence({ runTypes: ["ZOOM-NEB-TS"], status: "finished", converged: true, imaginaryModes: 1 });
    expect(b?.label).toBe("Converged · valid TS");
  });

  test("NEB-CI stays a plain convergence (band verdict, no TS expectation)", () => {
    const b = runsTableConvergence({ runTypes: ["NEB-CI"], status: "finished", converged: true, imaginaryModes: undefined });
    expect(b?.label).toBe("Converged");
    expect(isTSSearchRun({ runTypes: ["NEB-CI"] })).toBe(false);
  });

  test("stationaryPointVerdict judges NEB-TS like OptTS", () => {
    expect(stationaryPointVerdict({ runTypes: ["NEB-TS"] }, true, [-450])).toBeNull();
    expect(stationaryPointVerdict({ runTypes: ["NEB-TS"] }, true, [])?.tone).toBe("bad");
    expect(stationaryPointVerdict({ runTypes: ["NEB-TS"] }, true, [-450, -20])?.tone).toBe("warn");
  });
});

describe("max-opt-cycles state", () => {
  test("stalled opt gets its own warn badge, not Failed/Not converged", () => {
    const b = runsTableConvergence({ runTypes: ["OPT"], status: "finished", converged: false, optMaxCycles: true });
    expect(b?.tone).toBe("warn");
    expect(b?.label).toBe("Max opt cycles");
  });

  test("max cycles wins over failed status (stalled, not crashed)", () => {
    const b = runsTableConvergence({ runTypes: ["OPT"], status: "failed", converged: false, optMaxCycles: true });
    expect(b?.label).toBe("Max opt cycles");
  });

  test("a crash without the flag still reads Not converged / Failed", () => {
    expect(runsTableConvergence({ runTypes: ["OPT"], status: "finished", converged: false })?.label).toBe("Not converged");
    expect(runsTableConvergence({ runTypes: ["OPT"], status: "failed", converged: undefined })?.label).toBe("Failed");
  });

  test("converged run ignores a stale flag", () => {
    const b = runsTableConvergence({ runTypes: ["OPT"], status: "finished", converged: true, imaginaryModes: 0, optMaxCycles: true });
    expect(b?.label).toBe("Converged");
  });

  test("tsVerdict reports the stall explicitly", () => {
    const v = tsVerdict({ status: "finished", converged: false, optMaxCycles: true }, 10, [-100]);
    expect(v.label).toBe("Max opt cycles");
    expect(v.tone).toBe("bad");
  });
});

describe("NEB band convergence gating", () => {
  test("a NEB whose band never converged is Not converged, not a green Finished", () => {
    const b = runsTableConvergence({ runTypes: ["NEB-CI"], status: "finished", converged: false });
    expect(b?.tone).toBe("noconv");
    expect(b?.label).toBe("Not converged");
  });

  test("a converged band still reads Converged", () => {
    expect(runsTableConvergence({ runTypes: ["NEB-CI"], status: "finished", converged: true })?.label).toBe("Converged");
  });

  test("genuinely non-gated runs keep the Finished label", () => {
    const b = runsTableConvergence({ runTypes: ["SP"], status: "finished", converged: false });
    expect(b?.label).toBe("Finished");
    expect(b?.tone).toBe("ok");
  });
});
