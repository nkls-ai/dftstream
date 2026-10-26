/**
 * Pure measurement math + labeling for the StructureViewer's
 * distance / angle / dihedral picking modes.
 */
import { atomAngle, atomDihedral, atomDistance, type Vec3 } from "../geometry";

export type MeasureMode = "off" | "distance" | "angle" | "dihedral";

export interface PickedAtom {
  /** 1-based display index (matches atom labels). */
  index: number;
  elem: string;
  pos: Vec3;
}

export interface Measurement {
  mode: MeasureMode;
  atoms: PickedAtom[];
  value: number;
  label: string;
}

/** Number of picked atoms each mode needs before a measurement completes. */
export const MEASURE_ATOMS: Record<MeasureMode, number> = {
  off: 0,
  distance: 2,
  angle: 3,
  dihedral: 4,
};

/**
 * Computes the measurement value + human label for a complete pick set.
 * Returns value 0 / empty label for "off" (callers never pass it).
 */
export function computeMeasurement(
  mode: MeasureMode,
  atoms: PickedAtom[],
): { value: number; label: string } {
  let value = 0;
  let label = "";
  const names = atoms.map((a) => `${a.elem}${a.index}`);

  if (mode === "distance") {
    value = atomDistance(atoms[0]!.pos, atoms[1]!.pos);
    label = `${names[0]}–${names[1]}: ${value.toFixed(3)} Å`;
  } else if (mode === "angle") {
    value = atomAngle(atoms[0]!.pos, atoms[1]!.pos, atoms[2]!.pos);
    label = `∠${names.join("–")}: ${value.toFixed(1)}°`;
  } else if (mode === "dihedral") {
    value = atomDihedral(atoms[0]!.pos, atoms[1]!.pos, atoms[2]!.pos, atoms[3]!.pos);
    label = `φ ${names.join("–")}: ${value.toFixed(1)}°`;
  }

  return { value, label };
}
