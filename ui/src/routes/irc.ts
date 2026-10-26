import { parseMultiXYZ } from "../components/xyz";

export interface IRCPoint {
  step: number;
  direction: "forward" | "backward";
  energy: number;
  dE: number;
  rmsForce?: number;
  xyz?: string;
}

export interface IRCSummary {
  forward: IRCPoint[];
  backward: IRCPoint[];
  tsEnergy: number | null;
  converged: boolean;
}

export interface IRCPathPoint {
  pathIndex: number;
  energy: number;
  relativeKcal: number;
  direction: "forward" | "backward";
  step: number;
  xyz?: string;
}

const reIRCStep = /IRC STEP\s+(\d+)/;
const reEnergy = /E\s+\.{3}\s+(-?\d+\.\d+)\s+Eh/;
const reDeltaE = /dE\s+\.{3}\s+(-?\d+\.\d+)/;
const reRmsForce = /RMS\(F\)\s+\.{3}\s+(\d+\.\d+)/;
const reAtomLine = /^\s*[A-Z][a-z]?\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s*$/;
import { HARTREE_TO_KCAL } from "../lib/constants";

// ORCA 6 compact table row: "    0      -974.762897    1.487744    0.016349  0.005552"
const reCompactRow = /^\s+(\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)\s*$/;

// IRC PATH SUMMARY row: "   1      -974.767123   -1.163528    0.001928  0.000443"
// May end with "<= TS"
const reSummaryRow = /^\s+(\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)\s*(?:<=\s*TS)?\s*$/;

export function parseIRCOutput(text: string): IRCSummary | null {
  if (!/INTRINSIC REACTION COORD/i.test(text)) return null;

  // Try the verbose per-step format first (older ORCA / some versions).
  const verbose = parseVerboseIRC(text);
  if (verbose && (verbose.forward.length > 0 || verbose.backward.length > 0)) {
    return verbose;
  }

  // Fall back to ORCA 6 compact table format + PATH SUMMARY.
  return parseCompactIRC(text);
}

// Parses older ORCA format: "IRC STEP N" blocks with "E ... value Eh" lines.
function parseVerboseIRC(text: string): IRCSummary | null {
  const lines = text.split("\n");
  let direction: "forward" | "backward" = "forward";
  let converged = false;
  const forward: IRCPoint[] = [];
  const backward: IRCPoint[] = [];

  let currentStep: Partial<IRCPoint> | null = null;
  let inGeom = false;
  let geomAtoms: string[] = [];

  const flushStep = () => {
    if (!currentStep || currentStep.energy === undefined) return;
    const point: IRCPoint = {
      step: currentStep.step ?? 0,
      direction: currentStep.direction ?? direction,
      energy: currentStep.energy,
      dE: currentStep.dE ?? 0,
      rmsForce: currentStep.rmsForce,
      xyz: currentStep.xyz,
    };
    if (point.direction === "forward") {
      forward.push(point);
    } else {
      backward.push(point);
    }
    currentStep = null;
  };

  const flushGeom = () => {
    if (geomAtoms.length > 0 && currentStep) {
      const header = `${geomAtoms.length}\nIRC step ${currentStep.step ?? 0}`;
      currentStep.xyz = `${header}\n${geomAtoms.join("\n")}`;
    }
    geomAtoms = [];
    inGeom = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (inGeom) {
      if (reAtomLine.test(line)) {
        geomAtoms.push(line.trim());
        continue;
      }
      if (line.trim() === "" && geomAtoms.length > 0) {
        flushGeom();
        continue;
      }
      if (line.trim().startsWith("-")) continue;
      if (geomAtoms.length > 0) flushGeom();
      else { inGeom = false; continue; }
    }

    if (/IRC-DIRECTION:\s*FORWARD/i.test(line) || /STARTING DIRECTION\s*:\s*FORWARD/i.test(line)) {
      direction = "forward";
      continue;
    }
    if (/IRC-DIRECTION:\s*BACKWARD/i.test(line) || /Now changing to BACKWARD/i.test(line) ||
        /STARTING DIRECTION\s*:\s*BACKWARD/i.test(line) || /Now changing direction/i.test(line)) {
      flushStep();
      direction = "backward";
      continue;
    }

    const stepMatch = line.match(reIRCStep);
    if (stepMatch) {
      flushStep();
      const stepNum = Number(stepMatch[1]);
      if (!Number.isFinite(stepNum)) continue;
      currentStep = { step: stepNum, direction };
      continue;
    }

    if (currentStep) {
      const eMatch = line.match(reEnergy);
      if (eMatch) {
        const v = Number(eMatch[1]);
        if (Number.isFinite(v)) currentStep.energy = v;
        continue;
      }
      const deMatch = line.match(reDeltaE);
      if (deMatch) {
        const v = Number(deMatch[1]);
        if (Number.isFinite(v)) currentStep.dE = v;
        continue;
      }
      const fMatch = line.match(reRmsForce);
      if (fMatch) {
        const v = Number(fMatch[1]);
        if (Number.isFinite(v)) currentStep.rmsForce = v;
        continue;
      }
    }

    if (/CARTESIAN COORDINATES \(ANGSTROEM\)/.test(line)) {
      if (inGeom && geomAtoms.length > 0) flushGeom();
      inGeom = true;
      geomAtoms = [];
      continue;
    }

    if (/IRC CONVERGED|THE IRC HAS CONVERGED/i.test(line)) {
      converged = true;
    }
  }

  flushStep();

  if (forward.length === 0 && backward.length === 0) return null;

  const tsEnergy = forward.length > 0 ? forward[0]!.energy : backward.length > 0 ? backward[0]!.energy : null;

  return { forward, backward, tsEnergy, converged };
}

// Parses ORCA 6 compact format: direction headers with iteration tables,
// plus the IRC PATH SUMMARY table.
function parseCompactIRC(text: string): IRCSummary | null {
  const lines = text.split("\n");
  let converged = false;
  let direction: "forward" | "backward" | null = null;
  let inTable = false;
  const forward: IRCPoint[] = [];
  const backward: IRCPoint[] = [];

  // Phase 1: Parse per-direction iteration tables.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (/\*\s*FORWARD IRC\s*\*/i.test(line)) {
      direction = "forward";
      inTable = false;
      continue;
    }
    if (/\*\s*BACKWARD IRC\s*\*/i.test(line)) {
      direction = "backward";
      inTable = false;
      continue;
    }

    // Table header line marks start of iteration data.
    if (direction && /^\s*Iteration\s+E\(Eh\)/i.test(line)) {
      inTable = true;
      continue;
    }
    // Skip "Convergence thresholds" subheader.
    if (inTable && /Convergence thresholds/i.test(line)) continue;

    if (inTable && direction) {
      const m = line.match(reCompactRow);
      if (m) {
        const step = Number(m[1]);
        const energy = Number(m[2]);
        const dE = Number(m[3]);
        const rmsForce = Number(m[5]);
        if (Number.isFinite(energy)) {
          const point: IRCPoint = {
            step,
            direction,
            energy,
            dE,
            rmsForce: Number.isFinite(rmsForce) ? rmsForce : undefined,
          };
          if (direction === "forward") forward.push(point);
          else backward.push(point);
        }
        continue;
      }
      // Non-matching line ends table.
      if (line.trim() !== "") inTable = false;
    }

    if (/IRC CONVERGED|THE IRC HAS CONVERGED/i.test(line)) {
      converged = true;
    }

    // Stop before PATH SUMMARY — we already have per-direction data.
    if (/IRC PATH SUMMARY/i.test(line)) break;
  }

  // If per-direction parsing found data, use it. Extract TS energy
  // from PATH SUMMARY (the iteration tables don't contain it — step 0
  // is after the initial displacement, not the TS itself).
  if (forward.length > 0 || backward.length > 0) {
    const tsEnergy = extractTSEnergy(lines) ?? forward[0]?.energy ?? backward[0]?.energy ?? null;
    return { forward, backward, tsEnergy, converged };
  }

  // Phase 2: Fall back to IRC PATH SUMMARY table.
  return parseSummaryTable(lines, converged);
}

// Scan PATH SUMMARY for the "<= TS" row and return its energy.
function extractTSEnergy(lines: string[]): number | null {
  let inSummary = false;
  for (const line of lines) {
    if (/IRC PATH SUMMARY/i.test(line)) { inSummary = true; continue; }
    if (!inSummary) continue;
    if (/<=\s*TS/.test(line)) {
      const m = line.match(reSummaryRow);
      if (m) return Number(m[2]);
    }
  }
  return null;
}

// Parse the combined PATH SUMMARY table that lists backward + TS + forward
// in a single sequence. The TS row is marked with "<= TS".
function parseSummaryTable(lines: string[], converged: boolean): IRCSummary | null {
  let inSummary = false;
  const rows: { step: number; energy: number; dE: number; maxG: number; rmsG: number; isTS: boolean }[] = [];

  for (const line of lines) {
    if (/IRC PATH SUMMARY/i.test(line)) {
      inSummary = true;
      continue;
    }
    if (!inSummary) continue;

    // Header/separator lines.
    if (/^\s*Step\s+E\(Eh\)/i.test(line)) continue;
    if (/All gradients/i.test(line)) continue;
    if (/^[\s-]*$/.test(line)) {
      if (rows.length > 0) break;
      continue;
    }

    const m = line.match(reSummaryRow);
    if (m) {
      rows.push({
        step: Number(m[1]),
        energy: Number(m[2]),
        dE: Number(m[3]),
        maxG: Number(m[4]),
        rmsG: Number(m[5]),
        isTS: /<=\s*TS/.test(line),
      });
      continue;
    }

    // Non-matching non-empty line after we've started = end of table.
    if (rows.length > 0) break;
  }

  if (rows.length === 0) return null;

  const tsIdx = rows.findIndex((r) => r.isTS);
  let tsEnergy: number | null = null;

  const backward: IRCPoint[] = [];
  const forward: IRCPoint[] = [];

  if (tsIdx >= 0) {
    tsEnergy = rows[tsIdx]!.energy;
    // Rows before TS are backward (listed in reverse order in summary).
    for (let i = 0; i < tsIdx; i++) {
      const r = rows[i]!;
      backward.push({
        step: tsIdx - i,
        direction: "backward",
        energy: r.energy,
        dE: r.dE,
        rmsForce: r.rmsG,
      });
    }
    backward.reverse();
    // TS itself is step 0 of forward.
    forward.push({
      step: 0,
      direction: "forward",
      energy: rows[tsIdx]!.energy,
      dE: 0,
      rmsForce: rows[tsIdx]!.rmsG,
    });
    // Rows after TS are forward.
    for (let i = tsIdx + 1; i < rows.length; i++) {
      const r = rows[i]!;
      forward.push({
        step: i - tsIdx,
        direction: "forward",
        energy: r.energy,
        dE: r.dE,
        rmsForce: r.rmsG,
      });
    }
  } else {
    // No TS marker — treat all as forward.
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      forward.push({
        step: i,
        direction: "forward",
        energy: r.energy,
        dE: r.dE,
        rmsForce: r.rmsG,
      });
    }
    tsEnergy = forward[0]?.energy ?? null;
  }

  return { forward, backward, tsEnergy, converged };
}

export function buildIRCPath(summary: IRCSummary): IRCPathPoint[] {
  const tsE = summary.tsEnergy ?? 0;
  const path: IRCPathPoint[] = [];

  const bwdReversed = [...summary.backward].reverse();

  // In the verbose format, backward step 0 and forward step 0 are the
  // TS itself (same energy as tsEnergy). In ORCA 6 compact format,
  // step 0 is already displaced from the TS — the TS energy comes from
  // the PATH SUMMARY and doesn't appear in either direction's steps.
  const fwd0IsTS = summary.forward[0] != null &&
    Math.abs(summary.forward[0].energy - tsE) < 1e-8;
  const bwd0IsTS = summary.backward[0] != null &&
    Math.abs(summary.backward[0].energy - tsE) < 1e-8;

  // Backward points (reversed so earliest = most displaced from TS).
  for (let i = 0; i < bwdReversed.length; i++) {
    const p = bwdReversed[i]!;
    const isLast = i === bwdReversed.length - 1;
    // In verbose format the last reversed backward IS the TS (pathIndex 0).
    // In compact format it's just the closest backward point.
    if (isLast && bwd0IsTS) {
      path.push({
        pathIndex: 0,
        energy: p.energy,
        relativeKcal: (p.energy - tsE) * HARTREE_TO_KCAL,
        direction: "forward",
        step: p.step,
        xyz: p.xyz ?? summary.forward[0]?.xyz,
      });
    } else {
      path.push({
        pathIndex: -(bwdReversed.length - 1 - i) - (bwd0IsTS ? 0 : 1),
        energy: p.energy,
        relativeKcal: (p.energy - tsE) * HARTREE_TO_KCAL,
        direction: "backward",
        step: p.step,
        xyz: p.xyz,
      });
    }
  }

  // If step 0 is NOT the TS (compact format), insert a TS point.
  if (!bwd0IsTS && bwdReversed.length > 0) {
    path.push({
      pathIndex: 0,
      energy: tsE,
      relativeKcal: 0,
      direction: "forward",
      step: 0,
    });
  }

  // Forward points.
  for (let i = 0; i < summary.forward.length; i++) {
    const p = summary.forward[i]!;
    // In verbose format, skip forward step 0 when backward already
    // contributed the TS point.
    if (i === 0 && fwd0IsTS && bwdReversed.length > 0) continue;
    path.push({
      pathIndex: fwd0IsTS ? i : i + 1,
      energy: p.energy,
      relativeKcal: (p.energy - tsE) * HARTREE_TO_KCAL,
      direction: "forward",
      step: p.step,
      xyz: p.xyz,
    });
  }

  // No backward data — forward-only run. May need TS at index 0.
  if (bwdReversed.length === 0 && !fwd0IsTS && summary.forward.length > 0) {
    path.unshift({
      pathIndex: 0,
      energy: tsE,
      relativeKcal: 0,
      direction: "forward",
      step: 0,
    });
  }

  return path;
}

export function mergeIRCXYZ(
  path: IRCPathPoint[],
  fullTrjText?: string,
  fwdTrjText?: string,
  bwdTrjText?: string,
): IRCPathPoint[] {
  if (fullTrjText) {
    const frames = parseMultiXYZ(fullTrjText);
    return path.map((p, i) => ({
      ...p,
      xyz: frames[i] ?? p.xyz,
    }));
  }

  if (fwdTrjText || bwdTrjText) {
    const fwdFrames = fwdTrjText ? parseMultiXYZ(fwdTrjText) : [];
    const bwdFrames = bwdTrjText ? parseMultiXYZ(bwdTrjText) : [];
    const bwdReversed = [...bwdFrames].reverse();

    let bIdx = 0;
    let fIdx = 0;
    return path.map((p) => {
      let xyz = p.xyz;
      if (p.direction === "backward" && p.pathIndex < 0) {
        xyz = bwdReversed[bIdx++] ?? p.xyz;
      } else {
        xyz = fwdFrames[fIdx++] ?? p.xyz;
      }
      return { ...p, xyz };
    });
  }

  return path;
}
