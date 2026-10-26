import { describe, expect, test } from "bun:test";
import {
  convergenceToneOf,
  hasMethodDetails,
  imaginaryModesSummary,
  imaginaryModesTone,
  methodDisplayValue,
  resolveIrScale,
  solventDisplayLabel,
} from "./runOverviewData";
import { lookupScaleFactor } from "../lib/irSpectrum";

describe("solventDisplayLabel", () => {
  test("model + solvent", () => {
    expect(solventDisplayLabel({ solvent: "water", solventModel: "CPCM" })).toBe(
      "CPCM(water)",
    );
  });
  test("solvent only", () => {
    expect(solventDisplayLabel({ solvent: "toluene" })).toBe("toluene");
  });
  test("no solvent yields null even with a model", () => {
    expect(solventDisplayLabel({ solventModel: "CPCM" })).toBeNull();
    expect(solventDisplayLabel({})).toBeNull();
  });
});

describe("hasMethodDetails", () => {
  test("empty run has no details", () => {
    expect(hasMethodDetails({}, null)).toBe(false);
  });
  test("empty arrays do not count", () => {
    expect(
      hasMethodDetails({ runTypes: [], corrections: [], keywords: [] }, null),
    ).toBe(false);
  });
  test("charge 0 counts (null check, not truthiness)", () => {
    expect(hasMethodDetails({ charge: 0 }, null)).toBe(true);
  });
  test("solvent label alone counts", () => {
    expect(hasMethodDetails({}, "CPCM(water)")).toBe(true);
  });
  test("functional alone counts", () => {
    expect(hasMethodDetails({ functional: "B3LYP" }, null)).toBe(true);
  });
});

describe("methodDisplayValue", () => {
  test("functional/basis", () => {
    expect(methodDisplayValue({ functional: "B3LYP", basis: "def2-SVP" })).toBe(
      "B3LYP/def2-SVP",
    );
  });
  test("functional without basis", () => {
    expect(methodDisplayValue({ functional: "B3LYP" })).toBe("B3LYP");
  });
  test("method used when no functional", () => {
    expect(methodDisplayValue({ method: "DLPNO-CCSD(T)", basis: "cc-pVTZ" })).toBe(
      "DLPNO-CCSD(T)/cc-pVTZ",
    );
  });
  test("basis-only fallback", () => {
    expect(methodDisplayValue({ basis: "def2-SVP" })).toBe("def2-SVP");
    expect(methodDisplayValue({})).toBe("");
  });
});

describe("resolveIrScale", () => {
  test("functional/basis override wins", () => {
    expect(
      resolveIrScale({ "B3LYP/def2-SVP": 0.99, B3LYP: 0.95 }, "B3LYP", "def2-SVP"),
    ).toBe(0.99);
  });
  test("bare-functional override is the second choice", () => {
    expect(resolveIrScale({ B3LYP: 0.95 }, "B3LYP", "def2-SVP")).toBe(0.95);
  });
  test("falls back to the built-in table", () => {
    expect(resolveIrScale({}, "B3LYP", "def2-SVP")).toBe(
      lookupScaleFactor("B3LYP", "def2-SVP"),
    );
  });
  test("undefined functional falls through to table lookup", () => {
    expect(resolveIrScale({}, undefined, undefined)).toBe(
      lookupScaleFactor(undefined, undefined),
    );
  });
});

describe("convergenceToneOf", () => {
  test("maps states to tone suffixes", () => {
    expect(convergenceToneOf("ok")).toBe("ok");
    expect(convergenceToneOf("bad")).toBe("bad");
    expect(convergenceToneOf("pending")).toBe("pending");
  });
});

describe("imaginaryModesTone", () => {
  test("zero modes is ok", () => {
    expect(imaginaryModesTone(0, false)).toBe("ok");
    expect(imaginaryModesTone(0, true)).toBe("ok");
  });
  test("exactly one mode is ok only for OptTS", () => {
    expect(imaginaryModesTone(1, true)).toBe("ok");
    expect(imaginaryModesTone(1, false)).toBe("warn");
  });
  test("two modes always warn", () => {
    expect(imaginaryModesTone(2, true)).toBe("warn");
    expect(imaginaryModesTone(2, false)).toBe("warn");
  });
});

describe("imaginaryModesSummary", () => {
  test("empty list reads as clean", () => {
    expect(imaginaryModesSummary([])).toBe("clean spectrum");
  });
  test("joins rounded wavenumbers", () => {
    expect(
      imaginaryModesSummary([{ wavenumber: -512.34 }, { wavenumber: -33.6 }]),
    ).toBe("-512 cm⁻¹ · -34 cm⁻¹");
  });
});
