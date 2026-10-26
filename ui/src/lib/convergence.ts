// Pure classification of run convergence / stationary-point quality.
// All the "is this converged / a valid TS / a true minimum" business rules
// live here so every badge and verdict band renders from the same logic and
// the rules are unit-testable without React.

import type { Run, RunStatus } from "../data/types";

// ---------------------------------------------------------------------------
// ORCA run-type keyword families
// ---------------------------------------------------------------------------

/** Plain geometry minimizations. */
export const MINIMIZATION_RUN_TYPES = ["OPT", "COPT"] as const;
/** Transition-state optimization. */
export const OPTTS_RUN_TYPE = "OPTTS" as const;
/**
 * Run types whose success condition is a 1st-order saddle (exactly one
 * imaginary mode): OptTS itself plus the NEB-TS variants, whose final
 * phase is a regular OptTS. Mirrors Go's RunType.IsTransitionStateSearch.
 */
export const TS_SEARCH_RUN_TYPES = [OPTTS_RUN_TYPE, "NEB-TS", "ZOOM-NEB-TS"] as const;
/** Every run type ending in a success-gating geometry optimization. */
export const OPT_RUN_TYPES = [...MINIMIZATION_RUN_TYPES, ...TS_SEARCH_RUN_TYPES] as const;
/**
 * Run types that drive the NEB band optimizer. Like optimizations, merely
 * finishing is not success — the band has its own convergence criterion,
 * so `converged: false` on these means "did not converge", not "fine".
 */
export const NEB_BAND_RUN_TYPES = ["NEB", "NEB-CI", "NEB-TS", "ZOOM-NEB", "ZOOM-NEB-CI", "ZOOM-NEB-TS"] as const;
/** Explicit final-hessian frequency job keywords. */
export const FREQ_RUN_TYPES = ["FREQ", "NUMFREQ", "ANFREQ"] as const;

type RunTypesLike = Pick<Run, "runTypes">;

export function isMinimizationRun(r: RunTypesLike): boolean {
  return r.runTypes?.some((t) => (MINIMIZATION_RUN_TYPES as readonly string[]).includes(t)) ?? false;
}

/** Strictly OptTS — use only where the NEB-TS variants genuinely differ (e.g. opt-trajectory sections). */
export function isOptTSRun(r: RunTypesLike): boolean {
  return r.runTypes?.includes(OPTTS_RUN_TYPE) ?? false;
}

/** Any saddle-point search (OptTS or NEB-TS variants) — the predicate verdicts key off. */
export function isTSSearchRun(r: RunTypesLike): boolean {
  return r.runTypes?.some((t) => (TS_SEARCH_RUN_TYPES as readonly string[]).includes(t)) ?? false;
}

export function isOptimizationRun(r: RunTypesLike): boolean {
  return r.runTypes?.some((t) => (OPT_RUN_TYPES as readonly string[]).includes(t)) ?? false;
}

export function isNEBBandRun(r: RunTypesLike): boolean {
  return r.runTypes?.some((t) => (NEB_BAND_RUN_TYPES as readonly string[]).includes(t)) ?? false;
}

/**
 * Runs whose `converged: false` is a real failure, not just "no optimizer".
 *
 * The inverse matters just as much: on a single point, a scan or a plain Freq
 * there is nothing to converge geometrically, so `converged` carries no
 * verdict and must never be rendered as one.
 */
export function isConvergenceGated(r: RunTypesLike): boolean {
  return isOptimizationRun(r) || isNEBBandRun(r);
}

export function hasExplicitFreq(r: RunTypesLike): boolean {
  return r.runTypes?.some((t) => (FREQ_RUN_TYPES as readonly string[]).includes(t)) ?? false;
}

/** A run that is still in flight (queued or running). */
export function isActiveStatus(status: RunStatus): boolean {
  return status === "running" || status === "pending";
}

// ---------------------------------------------------------------------------
// Convergence badges (runs table + batch table)
// ---------------------------------------------------------------------------

/** Matches the conv-badge CSS modifier classes. */
export type ConvBadgeTone = "ok" | "warn" | "failed" | "running" | "noconv";

export interface ConvBadge {
  tone: ConvBadgeTone;
  label: string;
  title?: string;
}

type ConvFacts = Pick<Run, "status" | "converged" | "optMaxCycles" | "imaginaryModes" | "runTypes">;

/** Optimizer stalled at the cycle limit — not a success, but not a crash either. */
function maxCyclesBadge(r: Pick<Run, "converged" | "optMaxCycles">): ConvBadge | null {
  if (!r.optMaxCycles || r.converged === true) return null;
  return {
    tone: "warn",
    label: "Max opt cycles",
    title: "Optimizer hit the cycle limit without converging — `dftstream restart` continues from the last geometry",
  };
}

/**
 * Detailed convergence badge for the experiment runs table. Status is checked
 * first (an in-flight run never claims convergence), then the imaginary-mode
 * count refines converged optimizations into minimum / TS verdicts.
 * Returns null when there is nothing meaningful to show.
 */
export function runsTableConvergence(r: ConvFacts): ConvBadge | null {
  if (isActiveStatus(r.status)) return { tone: "running", label: r.status };
  const stalled = maxCyclesBadge(r);
  if (stalled) return stalled;
  if (r.status === "failed") return { tone: "failed", label: "Failed" };
  if (r.converged === true) {
    const optTS = isTSSearchRun(r);
    const imag = r.imaginaryModes;
    if (optTS && imag === 1) {
      return { tone: "ok", label: "Converged · valid TS", title: "Converged, 1 imaginary mode — valid TS" };
    }
    if (optTS && imag != null && imag !== 1) {
      return { tone: "warn", label: `Converged · ${imag} imag`, title: `Converged but ${imag} imaginary modes` };
    }
    if (imag === 0) {
      return { tone: "ok", label: "Converged", title: "Converged, no imaginary modes — true minimum" };
    }
    if (imag != null && imag > 0) {
      return { tone: "warn", label: `Converged · ${imag} imag`, title: `Converged but ${imag} imaginary mode(s)` };
    }
    return { tone: "ok", label: "Converged" };
  }
  if (r.converged === false) {
    if (isConvergenceGated(r)) return { tone: "noconv", label: "Not converged" };
    if (r.status === "finished") return { tone: "ok", label: "Finished" };
    return { tone: "noconv", label: "Not converged" };
  }
  // converged is undefined from here down — the parser reported no verdict.
  if (r.status === "finished") {
    // ORCA prints ****ORCA TERMINATED NORMALLY**** whether or not the
    // optimizer converged, so on a convergence-gated run "finished" is a
    // statement about the process, not about the chemistry. A green "Finished"
    // badge here read as success on runs that had quietly stopped at a
    // non-stationary geometry.
    if (isConvergenceGated(r)) {
      return {
        tone: "warn",
        label: "Finished · convergence unknown",
        title:
          "ORCA exited normally, but no convergence verdict was recorded for this run. " +
          "ORCA prints TERMINATED NORMALLY even when an optimization did not converge — " +
          "open the run and check the .out before treating this geometry as optimized.",
      };
    }
    return { tone: "ok", label: "Finished" };
  }
  return null;
}

/**
 * Compact convergence label for the batch dashboard. Note the precedence:
 * an explicit converged flag wins over a still-running status (the wrapper
 * sets `converged` as soon as the optimizer reports it, possibly before the
 * frequency step ends). Returns null for the muted "unknown" cell.
 */
export function batchConvergence(r: ConvFacts): ConvBadge | null {
  const stalled = maxCyclesBadge(r);
  if (stalled) return stalled;
  if (r.status === "failed") return { tone: "failed", label: "Failed" };
  if (r.converged === true) return { tone: "ok", label: "Converged" };
  if (r.converged === false) return { tone: "noconv", label: "Not converged" };
  if (isActiveStatus(r.status)) return { tone: "running", label: r.status };
  return null;
}

// ---------------------------------------------------------------------------
// Overview-tab convergence verdict (with .out fallback parse)
// ---------------------------------------------------------------------------

export interface OverviewConvergence {
  state: "ok" | "bad" | "pending";
  label: string;
  sub?: string;
  loading?: boolean;
}

export interface OutTextState {
  /** Artifact list or body still resolving. */
  loading: boolean;
  /** A .out artifact exists for this run. */
  hasOut: boolean;
  /** Full .out text once downloaded. */
  text: string | undefined;
}

export const OPT_CONVERGED_RE = /THE OPTIMIZATION HAS CONVERGED/i;
export const ORCA_TERMINATED_RE = /ORCA TERMINATED NORMALLY/i;
export const SCF_CONVERGED_RE = /SCF CONVERGED AFTER\s+(\d+)\s+CYCLES/i;

/**
 * Convergence verdict for the run Overview tab. Prefers the DB `converged`
 * field (set by the Go parser during live run / import) over re-parsing the
 * .out content, since the artifact may be truncated or have missing chunks;
 * falls back to scanning the .out for older runs without the field.
 */
export function overviewConvergence(
  r: Pick<Run, "status" | "exitCode" | "converged" | "optMaxCycles">,
  isOptish: boolean,
  out: OutTextState,
): OverviewConvergence {
  if (isActiveStatus(r.status)) {
    return { state: "pending", label: "Running", sub: "still in progress" };
  }
  if (r.optMaxCycles && r.converged !== true) {
    return { state: "bad", label: "Max opt cycles", sub: "hit the cycle limit — `dftstream restart` continues from the last geometry" };
  }
  if (r.status === "failed") {
    return { state: "bad", label: "Failed", sub: `exit ${r.exitCode ?? "?"}` };
  }
  // Use the authoritative DB field when available.
  if (r.converged === true) {
    return { state: "ok", label: "Converged", sub: isOptish ? "geometry optimized" : undefined };
  }
  if (r.converged === false && isOptish) {
    return { state: "bad", label: "Not converged", sub: "optimizer did not finish" };
  }
  // Non-opt runs that finished with converged=false (old bug) or
  // converged=undefined — treat a normal exit as success.
  if (r.converged === false && r.status === "finished") {
    return { state: "ok", label: "Finished" };
  }
  // Fallback: parse .out content for older runs without the field.
  if (out.loading) {
    return { state: "pending", label: "Loading", sub: "reading .out", loading: true };
  }
  if (!out.hasOut) {
    return { state: "pending", label: "Unknown", sub: ".out not captured" };
  }
  const text = out.text ?? "";
  if (isOptish) {
    if (OPT_CONVERGED_RE.test(text)) {
      return { state: "ok", label: "Converged", sub: "geometry optimized" };
    }
    if (ORCA_TERMINATED_RE.test(text)) {
      return { state: "bad", label: "Not converged", sub: "optimizer did not finish" };
    }
    return { state: "pending", label: "Unknown", sub: "no convergence line in .out" };
  }
  const scfMatch = text.match(SCF_CONVERGED_RE);
  if (scfMatch) {
    return { state: "ok", label: "Converged", sub: `SCF in ${scfMatch[1]} iters` };
  }
  if (ORCA_TERMINATED_RE.test(text)) {
    return { state: "ok", label: "Finished", sub: "no SCF report" };
  }
  return { state: "pending", label: "Unknown", sub: "no convergence line in .out" };
}

// ---------------------------------------------------------------------------
// Transition-state verdict (TS tab)
// ---------------------------------------------------------------------------

export interface TSVerdict {
  tone: "ok" | "warn" | "bad";
  label: string;
  detail: string;
}

/**
 * Validates a TS optimization. An imaginary mode alone proves nothing unless
 * the optimizer actually converged: with Calc_Hess/Recalc_Hess ORCA prints
 * frequencies from intermediate hessians every few cycles, so an unconverged
 * or failed OptTS still shows "1 imaginary mode" — from a stale hessian at a
 * non-stationary geometry, not a transition state.
 */
export function tsVerdict(
  r: Pick<Run, "status" | "converged" | "optMaxCycles"> | undefined,
  totalFreqCount: number,
  imagWavenumbers: number[],
): TSVerdict {
  if (r?.status === "running") return { tone: "warn", label: "In progress", detail: "Optimization still running — any frequencies shown are from an intermediate hessian" };
  if (r?.optMaxCycles && r.converged !== true) return { tone: "bad", label: "Max opt cycles", detail: "The optimizer hit the cycle limit before converging — not a failure, but no stationary point either. `dftstream restart` continues from the last geometry." };
  if (r?.status === "failed") return { tone: "bad", label: "Run failed", detail: "ORCA did not finish — frequencies (if any) are from an intermediate hessian, not a validated TS" };
  if (r?.converged === false) return { tone: "bad", label: "Opt not converged", detail: "The optimizer did not converge — frequencies come from an intermediate hessian at a non-stationary geometry, so this is not a transition state" };
  if (totalFreqCount === 0) return { tone: "warn", label: "No frequencies", detail: "Frequency calculation not available — cannot validate TS" };
  if (imagWavenumbers.length === 1) return { tone: "ok", label: "Valid TS", detail: `1st-order saddle point confirmed — single imaginary mode at ${imagWavenumbers[0]!.toFixed(0)} cm⁻¹` };
  if (imagWavenumbers.length === 0) return { tone: "bad", label: "Not a TS", detail: "No imaginary modes — this is a minimum, not a saddle point" };
  return { tone: "warn", label: "Higher-order saddle", detail: `${imagWavenumbers.length} imaginary modes — not a clean 1st-order transition state` };
}

// ---------------------------------------------------------------------------
// "Minimum vs transition state" verdict (Overview tab callout)
// ---------------------------------------------------------------------------

export interface StationaryPointVerdict {
  tone: "warn" | "bad";
  text: string;
}

/**
 * Judges the imaginary-mode count of a finished optimization against what the
 * job type expects (OptTS wants exactly one, a minimization wants none).
 * Returns null when the spectrum is consistent — or when there is nothing
 * to judge.
 */
export function stationaryPointVerdict(
  r: RunTypesLike,
  hasFreq: boolean,
  imagWavenumbers: number[],
): StationaryPointVerdict | null {
  if (!hasFreq) return null;
  const list = imagWavenumbers.map((w) => w.toFixed(0)).join(", ");
  if (isTSSearchRun(r)) {
    if (imagWavenumbers.length === 1) return null;
    if (imagWavenumbers.length === 0) {
      return {
        tone: "bad",
        text: "No imaginary modes — this is a minimum, not a transition state. The TS search likely failed to locate the saddle point.",
      };
    }
    return {
      tone: "warn",
      text: `${imagWavenumbers.length} imaginary modes (${list} cm⁻¹) — TS is contaminated by additional negative directions.`,
    };
  }
  if (isMinimizationRun(r)) {
    if (imagWavenumbers.length === 0) return null;
    return {
      tone: "warn",
      text: `${imagWavenumbers.length} imaginary mode${imagWavenumbers.length === 1 ? "" : "s"} (${list} cm⁻¹) — not a true minimum on the PES.`,
    };
  }
  return null;
}
