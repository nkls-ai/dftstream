/**
 * The advanced panel's typed overrides: functional, basis, aux basis,
 * grid, SCF convergence, dispersion, RI mode — the §3 override groups.
 *
 * Each override REPLACES the preset token of the same category instead
 * of piling on next to it: "wB97X-D3 def2-TZVP" with a def2-QZVPP basis
 * override must become "wB97X-D3 def2-QZVPP", never a line carrying two
 * basis sets for ORCA to fight over. The free-text extraKeywords box
 * stays the escape hatch for everything not modeled here, and is applied
 * last.
 */
import {
  isAuxBasisToken,
  isBasisToken,
  isDispersionToken,
  isFunctionalToken,
  isGridToken,
  isRIToken,
  isScfTierToken,
} from "./keywordVocabulary";
import { MethodFamily } from "./types";

/** Integration grid override; Default keeps the preset's choice. */
export enum GridOverride {
  Default = "",
  DefGrid1 = "DEFGRID1",
  DefGrid2 = "DEFGRID2",
  DefGrid3 = "DEFGRID3",
}

/** SCF convergence override. */
export enum ScfOverride {
  Default = "",
  Normal = "NormalSCF",
  Tight = "TightSCF",
  VeryTight = "VeryTightSCF",
}

/** Dispersion-correction override. */
export enum DispersionOverride {
  Default = "",
  D3BJ = "D3BJ",
  D4 = "D4",
  NL = "NL",
}

/** RI-mode override. */
export enum RIOverride {
  Default = "",
  RIJCOSX = "RIJCOSX",
  RIJK = "RIJK",
  NoRI = "NORI",
}

/** Functionals offered by the override select ("" keeps the preset's). */
export const FUNCTIONAL_CHOICES: readonly string[] = [
  "B3LYP", "PBE0", "PBE", "TPSS", "TPSSh", "M06-2X",
  "CAM-B3LYP", "wB97X-D3", "wB97X-D4", "wB97X-V", "B2PLYP",
];

/** Orbital basis sets offered by the override select. */
export const BASIS_CHOICES: readonly string[] = [
  "def2-SVP", "def2-SV(P)", "def2-TZVP", "def2-TZVPP", "def2-TZVPD",
  "def2-QZVP", "def2-QZVPP",
  "ma-def2-SVP", "ma-def2-TZVP",
  "cc-pVDZ", "cc-pVTZ", "cc-pVQZ",
];

/** Auxiliary basis sets offered by the override select. */
export const AUX_BASIS_CHOICES: readonly string[] = [
  "def2/J", "def2/JK", "def2-TZVP/C", "def2-TZVPP/C", "cc-pVTZ/C", "AutoAux",
];

/** Every override group; "" everywhere means "exactly the preset". */
export interface AdvancedOverrides {
  functional: string;
  basis: string;
  auxBasis: string;
  grid: GridOverride;
  scf: ScfOverride;
  dispersion: DispersionOverride;
  ri: RIOverride;
}

export function defaultOverrides(): AdvancedOverrides {
  return {
    functional: "",
    basis: "",
    auxBasis: "",
    grid: GridOverride.Default,
    scf: ScfOverride.Default,
    dispersion: DispersionOverride.Default,
    ri: RIOverride.Default,
  };
}

export function hasOverrides(o: AdvancedOverrides): boolean {
  return Object.values(o).some((v) => v !== "");
}

/**
 * Whether the method override groups (functional/basis/aux/dispersion)
 * make sense for a preset family. Composites bundle their own basis and
 * corrections, and xTB has neither a functional nor a basis to swap —
 * offering the selects there would generate keyword lines ORCA rejects.
 */
export function methodOverridesApply(family: MethodFamily): boolean {
  return family === MethodFamily.DFT || family === MethodFamily.Wavefunction;
}

/** AutoAux is a keyword of its own, not a `…/X` fitting-basis name. */
function isAuxChoice(token: string): boolean {
  return isAuxBasisToken(token) || token.toUpperCase() === "AUTOAUX";
}

/**
 * Applies the overrides to a preset's method tokens: for each set
 * override, the preset tokens of that category are dropped and the
 * override token put in their place (at the position of the first token
 * it replaced, so the line keeps reading method-basis-accuracy).
 */
export function applyOverrides(keywords: string[], o: AdvancedOverrides): string[] {
  let out = [...keywords];
  const replace = (value: string, matches: (tok: string) => boolean) => {
    if (!value) return;
    let inserted = false;
    const next: string[] = [];
    for (const tok of out) {
      if (matches(tok)) {
        if (!inserted) {
          next.push(value);
          inserted = true;
        }
        continue; // every further token of the category is dropped
      }
      next.push(tok);
    }
    if (!inserted) next.push(value);
    out = next;
  };
  replace(o.functional, isFunctionalToken);
  replace(o.basis, isBasisToken);
  replace(o.auxBasis, isAuxChoice);
  replace(o.grid, isGridToken);
  replace(o.scf, isScfTierToken);
  replace(o.dispersion, isDispersionToken);
  replace(o.ri, isRIToken);
  return out;
}
