import { parseMultiXYZ } from "../components/xyz";

export interface NEBIteration {
  iter: number;
  hei: number;
  barrierEh: number;
  maxFp: number;
  rmsFp: number;
  isCI: boolean;
}

export interface NEBImage {
  index: number;
  distance: number;
  energy: number;
  xyz?: string;
}

export interface NEBSummary {
  iterations: NEBIteration[];
  finalImages: NEBImage[];
  interpPoints: { distance: number; energy: number }[];
  reactantEnergy: number | null;
  productEnergy: number | null;
  converged: boolean;
  tsImageIndex: number | null;
}

export function parseNEBOutput(text: string): NEBSummary | null {
  if (!/NEB OPTIMIZATION|Nudged Elastic Band/i.test(text)) return null;

  const lines = text.split("\n");
  const iterations: NEBIteration[] = [];
  let converged = false;
  let reactantE: number | null = null;
  let productE: number | null = null;
  let tsImageIndex: number | null = null;
  const pathImages: NEBImage[] = [];
  let inPathSummary = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const lbfgs = line.match(
      /^\s*LBFGS\s+(\d+)\s+(\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)/
    );
    if (lbfgs) {
      const cols = line.trim().split(/\s+/);
      const isCI = cols.length >= 9;
      iterations.push({
        iter: Number(lbfgs[1]),
        hei: Number(lbfgs[2]),
        barrierEh: Number(lbfgs[3]),
        maxFp: Number(lbfgs[4]),
        rmsFp: Number(lbfgs[5]),
        isCI,
      });
      continue;
    }

    if (/CI-NEB convergence|NEB CONVERGED|HURRAY/.test(line)) converged = true;

    if (/PATH SUMMARY/.test(line)) { inPathSummary = true; continue; }
    if (inPathSummary) {
      const row = line.match(/^\s*(\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)/);
      if (row) {
        const isCI = /<= CI/.test(line);
        if (isCI) tsImageIndex = Number(row[1]);
        pathImages.push({
          index: Number(row[1]),
          distance: Number(row[2]),
          energy: Number(row[4]),
        });
        continue;
      }
      if (/^-{3,}/.test(line.trim()) && pathImages.length > 0) {
        inPathSummary = false;
      }
    }

    const ciMatch = line.match(/Climbing image\s+\.\.\.\.\s+(\d+)/);
    if (ciMatch) tsImageIndex = Number(ciMatch[1]);

    const reactM = line.match(/Reactant:$/);
    if (reactM) {
      const nextLine = lines[i + 1] ?? "";
      const eM = nextLine.match(/E\s+\.\.\.\.\s+(-?\d+\.\d+)/);
      if (eM) reactantE = Number(eM[1]);
    }
    const prodM = line.match(/Product:$/);
    if (prodM) {
      const nextLine = lines[i + 1] ?? "";
      const eM = nextLine.match(/E\s+\.\.\.\.\s+(-?\d+\.\d+)/);
      if (eM) productE = Number(eM[1]);
    }
  }

  if (iterations.length === 0 && pathImages.length === 0) return null;
  if (tsImageIndex == null && iterations.length > 0) {
    tsImageIndex = iterations[iterations.length - 1]!.hei;
  }

  return {
    iterations,
    finalImages: pathImages,
    interpPoints: [],
    reactantEnergy: reactantE,
    productEnergy: productE,
    converged,
    tsImageIndex,
  };
}

export interface NEBInterpIteration {
  iter: number;
  images: NEBImage[];
  interp: { distance: number; energy: number }[];
}

/** Every `Iteration:` block of a .interp file, in file order — the energy
 *  profile of the band at each NEB step. */
export function parseNEBInterpIterations(text: string): NEBInterpIteration[] {
  const lines = text.split("\n");
  const iterations: NEBInterpIteration[] = [];
  let current: NEBInterpIteration | null = null;
  let section: "none" | "images" | "interp" = "none";

  for (let i = 0; i < lines.length; i++) {
    const iterM = lines[i]!.match(/^Iteration:\s*(\d+)/);
    if (iterM) {
      current = { iter: Number(iterM[1]), images: [], interp: [] };
      iterations.push(current);
      section = "none";
      continue;
    }
    if (/^Images:/.test(lines[i]!)) { section = "images"; continue; }
    if (/^Interp\.?:/.test(lines[i]!)) { section = "interp"; continue; }

    const row = lines[i]!.match(/^\s*(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s*$/);
    if (!row) {
      if (lines[i]!.trim() === "" && (section === "images" || section === "interp")) {
        continue;
      }
      if (section !== "none" && lines[i]!.trim() !== "") section = "none";
      continue;
    }
    if (!current) continue;

    if (section === "images") {
      current.images.push({
        index: current.images.length,
        distance: Number(row[2]),
        energy: Number(row[3]),
      });
    } else if (section === "interp") {
      current.interp.push({ distance: Number(row[2]), energy: Number(row[3]) });
    }
  }

  return iterations;
}

/** The last iteration's profile — the band as it currently stands. */
export function parseNEBInterp(text: string): { images: NEBImage[]; interp: { distance: number; energy: number }[] } {
  const last = parseNEBInterpIterations(text).at(-1);
  return { images: last?.images ?? [], interp: last?.interp ?? [] };
}

/** Split the concatenated _MEP_ALL_trj.xyz frames into one band per NEB
 *  iteration. Returns [] unless the frame count divides evenly — a partial
 *  final band (file caught mid-write) would otherwise shear every path. */
export function chunkPathFrames(frames: string[], imagesPerPath: number): string[][] {
  if (imagesPerPath <= 0 || frames.length === 0 || frames.length % imagesPerPath !== 0) {
    return [];
  }
  const paths: string[][] = [];
  for (let i = 0; i < frames.length; i += imagesPerPath) {
    paths.push(frames.slice(i, i + imagesPerPath));
  }
  return paths;
}

export function mergeNEBXYZ(
  images: NEBImage[],
  trjText: string | undefined,
): NEBImage[] {
  const frames = trjText ? parseMultiXYZ(trjText) : [];
  return images.map((img, i) => ({
    ...img,
    xyz: frames[i],
  }));
}
