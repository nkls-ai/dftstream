import { parseMultiXYZ } from "../components/xyz";
import { HARTREE_TO_KCAL } from "../lib/constants";

export interface ScanPoint {
  step: number;
  coords: number[];
  coordValue: number;
  energy: number;
  xyz?: string;
}

export interface ScanCoordinate {
  index: number;
  kind: "Bond" | "Angle" | "Dihedral" | "Coordinate";
  atoms: string;
  label: string;
}

export interface ScanSummary {
  coordLabel: string;
  coordinates: ScanCoordinate[];
  dimensions: number;
  points: ScanPoint[];
}

function numberPattern() {
  return "[-+]?\\d+(?:\\.\\d+)?(?:[Ee][-+]?\\d+)?";
}

function atomLabel(raw: string): string {
  return raw.trim().replace(/\s+/g, "").replace(/,/g, "-");
}

function coordKey(kind: string, atoms: string): string {
  const indices = atoms.match(/\d+/g) ?? [];
  return `${kind}:${indices.join(",")}`;
}

function makeCoordinate(index: number, kind: ScanCoordinate["kind"], atoms: string): ScanCoordinate {
  const atomText = atomLabel(atoms);
  return {
    index,
    kind,
    atoms: atomText,
    label: atomText ? `${kind} (${atomText})` : `Coordinate ${index + 1}`,
  };
}

function pushUniqueCoordinate(
  coordinates: ScanCoordinate[],
  kind: ScanCoordinate["kind"],
  atoms: string,
) {
  const key = coordKey(kind, atoms);
  if (coordinates.some((c) => coordKey(c.kind, c.atoms) === key)) return;
  coordinates.push(makeCoordinate(coordinates.length, kind, atoms));
}

function fallbackCoordinates(count: number, existing: ScanCoordinate[] = []): ScanCoordinate[] {
  const out = existing.slice(0, count);
  while (out.length < count) {
    out.push(makeCoordinate(out.length, "Coordinate", ""));
  }
  return out;
}

function coordLabel(coordinates: ScanCoordinate[]): string {
  if (coordinates.length === 0) return "Scan coordinate";
  if (coordinates.length === 1) return coordinates[0]!.label;
  return coordinates.map((c) => c.label).join(" × ");
}

function point(step: number, coords: number[], energy: number): ScanPoint {
  return {
    step,
    coords,
    coordValue: coords[0] ?? step,
    energy,
  };
}

export function parseScanOutput(text: string): ScanSummary | null {
  if (!text.includes("RELAXED SURFACE SCAN")) return null;

  const lines = text.split("\n");
  const points: ScanPoint[] = [];
  const coordinates: ScanCoordinate[] = [];
  let currentStep = 0;
  let lastEnergy: number | null = null;
  let currentCoords: number[] = [];
  let currentCoordKeys = new Set<string>();
  const n = numberPattern();

  const flush = () => {
    if (currentStep > 0 && lastEnergy != null && currentCoords.length > 0) {
      points.push(point(currentStep, currentCoords, lastEnergy));
    }
    lastEnergy = null;
    currentCoords = [];
    currentCoordKeys = new Set();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const rangeMatch = line.match(new RegExp(`\\b(Bond|Angle|Dihedral)\\s*\\(([^)]+)\\)\\s*:\\s*range\\s*=\\s*${n}\\s*\\.\\.\\s*${n}\\s+steps\\s*=\\s*\\d+`, "i"));
    if (rangeMatch) {
      pushUniqueCoordinate(coordinates, rangeMatch[1] as ScanCoordinate["kind"], rangeMatch[2]!);
      continue;
    }

    const stepMatch = line.match(/RELAXED SURFACE SCAN STEP\s+(\d+)/);
    if (stepMatch) {
      flush();
      currentStep = Number(stepMatch[1]);
      continue;
    }

    if (currentStep > 0) {
      const bannerMatch = line.match(new RegExp(`\\*\\s+(Bond|Angle|Dihedral)\\s*\\(([^)]+)\\)\\s*:\\s*(${n})`, "i"));
      if (bannerMatch) {
        const key = coordKey(bannerMatch[1]!, bannerMatch[2]!);
        pushUniqueCoordinate(coordinates, bannerMatch[1] as ScanCoordinate["kind"], bannerMatch[2]!);
        if (!currentCoordKeys.has(key)) {
          currentCoordKeys.add(key);
          currentCoords.push(Number(bannerMatch[3]));
        }
        continue;
      }
      const cMatch = line.match(new RegExp(`^\\s*\\d+\\.\\s*(B|A|D)\\(([^)]+)\\)\\s+(${n})\\s+${n}\\s+C\\s*$`, "i"));
      if (cMatch) {
        const kind = cMatch[1]!.toUpperCase() === "B" ? "Bond" : cMatch[1]!.toUpperCase() === "A" ? "Angle" : "Dihedral";
        const key = coordKey(kind, cMatch[2]!);
        pushUniqueCoordinate(coordinates, kind, cMatch[2]!);
        if (!currentCoordKeys.has(key)) {
          currentCoordKeys.add(key);
          currentCoords.push(Number(cMatch[3]));
        }
        continue;
      }
    }

    const eMatch = line.match(/FINAL SINGLE POINT ENERGY\s+(-?\d+\.\d+)/);
    if (eMatch) {
      lastEnergy = Number(eMatch[1]);
      continue;
    }

    if (line.includes("OPTIMIZATION RUN DONE")) {
      flush();
    }
  }

  flush();

  if (points.length > 0) {
    const dims = Math.max(...points.map((p) => p.coords.length));
    const finalCoordinates = fallbackCoordinates(dims, coordinates);
    return {
      coordLabel: coordLabel(finalCoordinates),
      coordinates: finalCoordinates,
      dimensions: dims,
      points,
    };
  }

  const summaryIdx = text.lastIndexOf("The Calculated Surface using the 'Actual Energy'");
  if (summaryIdx >= 0) {
    const summaryLines = text.slice(summaryIdx).split("\n");
    let step = 0;
    for (let i = 1; i < summaryLines.length && i < 500; i++) {
      const values = summaryLines[i]!.trim().split(/\s+/).map(Number).filter(Number.isFinite);
      if (values.length >= 2) {
        step++;
        points.push(point(step, values.slice(0, -1), values[values.length - 1]!));
      } else if (points.length > 0) {
        break;
      }
    }
  }

  if (points.length === 0) return null;
  const dims = Math.max(...points.map((p) => p.coords.length));
  const finalCoordinates = fallbackCoordinates(dims, coordinates);
  return {
    coordLabel: coordLabel(finalCoordinates),
    coordinates: finalCoordinates,
    dimensions: dims,
    points,
  };
}

export function parseScanDat(
  text: string | undefined,
  coordinates: ScanCoordinate[] = [],
): ScanSummary | null {
  if (!text) return null;
  const points: ScanPoint[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const values = trimmed.split(/\s+/).map(Number).filter(Number.isFinite);
    if (values.length < 2) continue;
    points.push(point(points.length + 1, values.slice(0, -1), values[values.length - 1]!));
  }
  if (points.length === 0) return null;
  const dims = Math.max(...points.map((p) => p.coords.length));
  const finalCoordinates = fallbackCoordinates(dims, coordinates);
  return {
    coordLabel: coordLabel(finalCoordinates),
    coordinates: finalCoordinates,
    dimensions: dims,
    points,
  };
}

export function mergeScanXYZ(
  summary: ScanSummary | null,
  trjText: string | undefined,
): ScanPoint[] {
  if (!summary) return [];
  const frames = trjText ? parseMultiXYZ(trjText) : [];
  return summary.points.map((p, i) => ({
    ...p,
    xyz: frames[i],
  }));
}

export type CriticalKind = "minimum" | "maximum" | "saddle";

export interface CriticalPoint {
  idx: number;
  kind: CriticalKind;
  energy: number;
  deltaE: number;
}

export function findCriticalPoints(points: ScanPoint[], dims: number): CriticalPoint[] {
  if (points.length < 3) return [];
  const minE = Math.min(...points.map((p) => p.energy));
  if (dims <= 1) return findCritical1D(points, minE);
  return findCritical2D(points, minE);
}

function findCritical1D(points: ScanPoint[], minE: number): CriticalPoint[] {
  const out: CriticalPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[i - 1]?.energy ?? Infinity;
    const curr = points[i]!.energy;
    const next = points[i + 1]?.energy ?? Infinity;
    if (curr <= prev && curr <= next) {
      out.push({ idx: i, kind: "minimum", energy: curr, deltaE: (curr - minE) * HARTREE_TO_KCAL });
    } else if (curr >= prev && curr >= next && i > 0 && i < points.length - 1) {
      out.push({ idx: i, kind: "maximum", energy: curr, deltaE: (curr - minE) * HARTREE_TO_KCAL });
    }
  }
  return out;
}

function findCritical2D(points: ScanPoint[], minE: number): CriticalPoint[] {
  const EPS = 1e-7;
  const ck = (c: number[]) => c.map((v) => v.toFixed(8)).join(",");
  const energyMap = new Map<string, { e: number; idx: number }>();
  for (let i = 0; i < points.length; i++) {
    energyMap.set(ck(points[i]!.coords), { e: points[i]!.energy, idx: i });
  }
  const dim0Vals = [...new Set(points.map((p) => p.coords[0] ?? 0))].sort((a, b) => a - b);
  const dim1Vals = [...new Set(points.map((p) => p.coords[1] ?? 0))].sort((a, b) => a - b);
  const step0 = dim0Vals.length > 1 ? dim0Vals[1]! - dim0Vals[0]! : 1;
  const step1 = dim1Vals.length > 1 ? dim1Vals[1]! - dim1Vals[0]! : 1;

  const neighbor = (c: number[], d0: number, d1: number) => {
    return energyMap.get(ck([(c[0] ?? 0) + d0, (c[1] ?? 0) + d1, ...c.slice(2)]));
  };

  const out: CriticalPoint[] = [];
  for (let pi = 0; pi < points.length; pi++) {
    const p = points[pi]!;
    const c = p.coords;
    const ns = [
      neighbor(c, step0, 0), neighbor(c, -step0, 0),
      neighbor(c, 0, step1), neighbor(c, 0, -step1),
    ].filter((n): n is { e: number; idx: number } => n != null);
    if (ns.length < 2) continue;

    const allLower = ns.every((n) => p.energy <= n.e + EPS);
    const allHigher = ns.every((n) => p.energy >= n.e - EPS);

    if (allLower) {
      out.push({ idx: pi, kind: "minimum", energy: p.energy, deltaE: (p.energy - minE) * HARTREE_TO_KCAL });
    } else if (allHigher) {
      out.push({ idx: pi, kind: "maximum", energy: p.energy, deltaE: (p.energy - minE) * HARTREE_TO_KCAL });
    } else {
      const d0p = neighbor(c, step0, 0)?.e, d0n = neighbor(c, -step0, 0)?.e;
      const d1p = neighbor(c, 0, step1)?.e, d1n = neighbor(c, 0, -step1)?.e;
      if (d0p == null || d0n == null || d1p == null || d1n == null) continue;
      const minInDim0 = p.energy <= d0p + EPS && p.energy <= d0n + EPS;
      const maxInDim0 = p.energy >= d0p - EPS && p.energy >= d0n - EPS;
      const minInDim1 = p.energy <= d1p + EPS && p.energy <= d1n + EPS;
      const maxInDim1 = p.energy >= d1p - EPS && p.energy >= d1n - EPS;
      if ((minInDim0 && maxInDim1) || (maxInDim0 && minInDim1)) {
        out.push({ idx: pi, kind: "saddle", energy: p.energy, deltaE: (p.energy - minE) * HARTREE_TO_KCAL });
      }
    }
  }
  return out;
}
