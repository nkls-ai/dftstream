/**
 * Pick-to-measure state machine for the StructureViewer: accumulates clicked
 * atoms until the active mode has enough, then records a measurement.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AtomSpec } from "3dmol";
import {
  MEASURE_ATOMS,
  computeMeasurement,
  type MeasureMode,
  type Measurement,
  type PickedAtom,
} from "../../lib/gl/measure";
import { atomDisplayIndex, isPickableAtom } from "./structureScene";

export interface MeasurementsApi {
  measureMode: MeasureMode;
  setMeasureMode: (mode: MeasureMode) => void;
  pickedAtoms: PickedAtom[];
  measurements: Measurement[];
  /** Stable identity — safe to hand to 3Dmol setClickable via effect deps. */
  handleAtomClick: (atom: AtomSpec) => void;
  removeMeasurement: (index: number) => void;
  clearMeasurements: () => void;
}

export function useMeasurements(xyz: string): MeasurementsApi {
  const [measureMode, setMeasureMode] = useState<MeasureMode>("off");
  const [pickedAtoms, setPickedAtoms] = useState<PickedAtom[]>([]);
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const measureModeRef = useRef(measureMode);
  measureModeRef.current = measureMode;
  const pickedRef = useRef(pickedAtoms);
  pickedRef.current = pickedAtoms;

  // Clear partial picks when switching modes, clear all when turning off
  useEffect(() => {
    setPickedAtoms([]);
    if (measureMode === "off") setMeasurements([]);
  }, [measureMode]);

  // Clear measurements when the molecule changes. Tracked via its own ref so
  // this never competes with the viewer's prevXyzRef bookkeeping.
  const prevMeasureXyzRef = useRef(xyz);
  useEffect(() => {
    if (xyz !== prevMeasureXyzRef.current) {
      prevMeasureXyzRef.current = xyz;
      setPickedAtoms([]);
      setMeasurements([]);
    }
  }, [xyz]);

  const handleAtomClick = useCallback((atom: AtomSpec) => {
    const mode = measureModeRef.current;
    if (mode === "off" || !isPickableAtom(atom)) return;

    const picked: PickedAtom = {
      index: atomDisplayIndex(atom),
      elem: atom.elem ?? "?",
      pos: { x: atom.x ?? 0, y: atom.y ?? 0, z: atom.z ?? 0 },
    };

    const needed = MEASURE_ATOMS[mode];
    const next = [...pickedRef.current, picked];

    if (next.length < needed) {
      setPickedAtoms(next);
      return;
    }

    const atoms = next.slice(0, needed);
    const { value, label } = computeMeasurement(mode, atoms);
    setMeasurements((prev) => [...prev, { mode, atoms, value, label }]);
    setPickedAtoms([]);
  }, []);

  const removeMeasurement = useCallback((index: number) => {
    setMeasurements((prev) => prev.filter((_, j) => j !== index));
  }, []);

  const clearMeasurements = useCallback(() => {
    setMeasurements([]);
    setPickedAtoms([]);
  }, []);

  return {
    measureMode,
    setMeasureMode,
    pickedAtoms,
    measurements,
    handleAtomClick,
    removeMeasurement,
    clearMeasurements,
  };
}
