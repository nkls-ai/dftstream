import { expect, test } from "bun:test";
import {
  applyOverrides,
  defaultOverrides,
  DispersionOverride,
  GridOverride,
  hasOverrides,
  methodOverridesApply,
  RIOverride,
  ScfOverride,
} from "./overrides";
import { MethodFamily } from "./types";

const PRESET = ["wB97X-D3", "def2-TZVP"];

test("no override leaves the preset exactly as it shipped", () => {
  expect(applyOverrides(PRESET, defaultOverrides())).toEqual(PRESET);
  expect(hasOverrides(defaultOverrides())).toBe(false);
});

test("an override REPLACES the preset's token of that category", () => {
  // The failure this exists to prevent: "def2-TZVP def2-QZVPP" on one
  // line, which is two basis sets for ORCA to fight over.
  const out = applyOverrides(PRESET, { ...defaultOverrides(), basis: "def2-QZVPP" });
  expect(out).toEqual(["wB97X-D3", "def2-QZVPP"]);

  const swapped = applyOverrides(PRESET, { ...defaultOverrides(), functional: "PBE0" });
  expect(swapped).toEqual(["PBE0", "def2-TZVP"]);
});

test("the override lands where the token it replaced was", () => {
  const out = applyOverrides(["wB97X-D4", "def2-TZVP", "TightSCF", "DEFGRID3"], {
    ...defaultOverrides(),
    basis: "cc-pVTZ",
    scf: ScfOverride.VeryTight,
  });
  expect(out).toEqual(["wB97X-D4", "cc-pVTZ", "VeryTightSCF", "DEFGRID3"]);
});

test("an override with nothing to replace is appended", () => {
  const out = applyOverrides(["r2SCAN-3c"], {
    ...defaultOverrides(),
    grid: GridOverride.DefGrid3,
    scf: ScfOverride.Tight,
  });
  expect(out).toEqual(["r2SCAN-3c", "DEFGRID3", "TightSCF"]);
});

test("a composite's own name survives a functional override", () => {
  // r2SCAN-3c matches the "SCAN" functional substring; treating it as a
  // functional would delete the whole method.
  const out = applyOverrides(["r2SCAN-3c"], { ...defaultOverrides(), functional: "PBE0" });
  expect(out).toContain("r2SCAN-3c");
});

test("aux basis, dispersion and RI each own their category", () => {
  const out = applyOverrides(["PBE0", "def2-TZVP", "def2/J", "D3BJ", "RIJCOSX"], {
    ...defaultOverrides(),
    auxBasis: "AutoAux",
    dispersion: DispersionOverride.D4,
    ri: RIOverride.RIJK,
  });
  expect(out).toEqual(["PBE0", "def2-TZVP", "AutoAux", "D4", "RIJK"]);
});

test("an aux basis is never mistaken for the orbital basis", () => {
  const out = applyOverrides(["DLPNO-CCSD(T)", "cc-pVTZ", "cc-pVTZ/C"], {
    ...defaultOverrides(),
    basis: "cc-pVQZ",
  });
  expect(out).toEqual(["DLPNO-CCSD(T)", "cc-pVQZ", "cc-pVTZ/C"]);
});

test("every duplicate of a replaced category is dropped, not just the first", () => {
  const out = applyOverrides(["PBE0", "def2-SVP", "def2-TZVP"], {
    ...defaultOverrides(),
    basis: "def2-QZVPP",
  });
  expect(out).toEqual(["PBE0", "def2-QZVPP"]);
});

test("method overrides are offered only where they mean something", () => {
  expect(methodOverridesApply(MethodFamily.DFT)).toBe(true);
  expect(methodOverridesApply(MethodFamily.Wavefunction)).toBe(true);
  // A composite brings its own basis; xTB has neither functional nor basis.
  expect(methodOverridesApply(MethodFamily.Composite)).toBe(false);
  expect(methodOverridesApply(MethodFamily.Semiempirical)).toBe(false);
});
