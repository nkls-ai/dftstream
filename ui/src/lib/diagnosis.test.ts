import { describe, expect, test } from "bun:test";
import {
  DIAGNOSES,
  ERROR_CLASSES,
  INPUT_FILE_PLACEHOLDER,
  MANUAL_TROUBLESHOOTING_LINK,
  RUN_OUT_PLACEHOLDER,
  diagnosisFor,
  errorClassLabel,
  isKnownErrorClass,
  resolveRemedyCommand,
} from "./diagnosis";

// The classifier contract: wrapper/internal/parser/diagnostics.go and
// db/convex/schema.ts define these exact string values. If this list drifts,
// stored runs stop being diagnosed.
const WRAPPER_CLASSES = [
  "scf_not_converged",
  "opt_max_cycles",
  "out_of_memory",
  "disk_or_scratch",
  "geometry_exploded",
  "charge_mult_impossible",
  "unstable_wavefunction",
  "basis_or_ecp_missing",
  "external_tool_failed",
  "input_error",
  "unknown",
];

describe("exhaustiveness", () => {
  test("ERROR_CLASSES matches the wrapper's classifier byte for byte", () => {
    expect(([...ERROR_CLASSES] as string[]).sort()).toEqual(
      [...WRAPPER_CLASSES].sort(),
    );
  });

  test("DIAGNOSES covers every class and nothing else", () => {
    expect(Object.keys(DIAGNOSES).sort()).toEqual([...ERROR_CLASSES].sort());
  });

  for (const cls of ERROR_CLASSES) {
    const d = DIAGNOSES[cls];
    test(`${cls}: label, title and a substantial cause`, () => {
      expect(d.label.trim().length).toBeGreaterThan(0);
      expect(d.title.trim().length).toBeGreaterThan(0);
      // "Plain-English cause, 2-4 sentences" — a one-liner is not a diagnosis.
      expect(d.cause.trim().length).toBeGreaterThan(120);
    });

    test(`${cls}: at least one valid https link with a label`, () => {
      expect(d.links.length).toBeGreaterThan(0);
      for (const link of d.links) {
        expect(link.label.trim().length).toBeGreaterThan(0);
        const url = new URL(link.href); // throws on malformed URLs
        expect(url.protocol).toBe("https:");
      }
    });

    test(`${cls}: at least one well-formed remedy`, () => {
      expect(d.remedies.length).toBeGreaterThan(0);
      for (const remedy of d.remedies) {
        if (remedy.kind === "cli") {
          // The command string is the whole contract with the wrapper.
          expect(remedy.command.startsWith("dftstream ")).toBe(true);
          expect(remedy.explanation.trim().length).toBeGreaterThan(0);
        } else {
          expect(remedy.description.trim().length).toBeGreaterThan(0);
          expect(remedy.keywords.length).toBeGreaterThan(0);
        }
      }
    });
  }

  test("the imaginary-mode severity note (large vs small) lives on opt_max_cycles", () => {
    const note = DIAGNOSES.opt_max_cycles.severityNote ?? "";
    expect(note).toContain("50i");
    expect(note.toLowerCase()).toContain("saddle point");
  });
});

describe("lookups", () => {
  test("isKnownErrorClass accepts the union and rejects the rest", () => {
    expect(isKnownErrorClass("out_of_memory")).toBe(true);
    expect(isKnownErrorClass("some_future_class")).toBe(false);
    expect(isKnownErrorClass(undefined)).toBe(false);
    expect(isKnownErrorClass(null)).toBe(false);
    expect(isKnownErrorClass("")).toBe(false);
  });

  test("diagnosisFor returns the entry for known classes and undefined otherwise", () => {
    expect(diagnosisFor("scf_not_converged")).toBe(DIAGNOSES.scf_not_converged);
    expect(diagnosisFor("some_future_class")).toBeUndefined();
    expect(diagnosisFor(undefined)).toBeUndefined();
  });

  test("errorClassLabel keeps the labels the failure tables always showed", () => {
    // These exact strings were ERROR_CLASS_LABELS in batchProgress.ts before
    // the table was consolidated here; batch dashboards must not change.
    expect(errorClassLabel("scf_not_converged")).toBe("SCF not converged");
    expect(errorClassLabel("opt_max_cycles")).toBe("Hit max opt cycles");
    expect(errorClassLabel("unknown")).toBe("Unclassified");
    // Unknown keys are humanized, never dropped.
    expect(errorClassLabel("some_future_class")).toBe("some future class");
  });
});

describe("resolveRemedyCommand", () => {
  test("substitutes the input path and the derived .out path", () => {
    const run = { inputPath: "/scratch/jobs/water_opt.inp" };
    expect(
      resolveRemedyCommand(`dftstream restart ${RUN_OUT_PLACEHOLDER}`, run),
    ).toBe("dftstream restart /scratch/jobs/water_opt.out");
    expect(
      resolveRemedyCommand(`dftstream lint ${INPUT_FILE_PLACEHOLDER}`, run),
    ).toBe("dftstream lint /scratch/jobs/water_opt.inp");
  });

  test("derives .out case-insensitively from .INP", () => {
    expect(
      resolveRemedyCommand(`dftstream restart ${RUN_OUT_PLACEHOLDER}`, {
        inputPath: "/x/MOL.INP",
      }),
    ).toBe("dftstream restart /x/MOL.out");
  });

  test("keeps the placeholders when the run has no recorded input path", () => {
    const cmd = `dftstream restart ${RUN_OUT_PLACEHOLDER}`;
    expect(resolveRemedyCommand(cmd, {})).toBe(cmd);
    expect(resolveRemedyCommand(cmd, { inputPath: "   " })).toBe(cmd);
  });

  test("every CLI remedy in the table resolves cleanly for a real path", () => {
    for (const cls of ERROR_CLASSES) {
      for (const remedy of DIAGNOSES[cls].remedies) {
        if (remedy.kind !== "cli") continue;
        const resolved = resolveRemedyCommand(remedy.command, {
          inputPath: "/home/phd/mol.inp",
        });
        expect(resolved).not.toContain("<");
        expect(resolved).not.toContain(">");
      }
    }
  });
});

test("the fallback manual link is the real troubleshooting page", () => {
  expect(MANUAL_TROUBLESHOOTING_LINK.href).toBe(
    "https://orca-manual.mpi-muelheim.mpg.de/contents/quickstartguide/troubleshooting.html",
  );
});
