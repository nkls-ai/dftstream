import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import type { Run } from "../data/types";
import {
  DIAGNOSES,
  ERROR_CLASSES,
  MANUAL_TROUBLESHOOTING_LINK,
} from "../lib/diagnosis";
import { RunDiagnosisPanel } from "./RunDiagnosisPanel";

function failedRun(partial: Partial<Run>): Run {
  return {
    id: "r1",
    experimentId: "e1",
    status: "failed",
    startedAt: 0,
    ...partial,
  } as Run;
}

describe("RunDiagnosisPanel", () => {
  for (const cls of ERROR_CLASSES) {
    test(`renders the full diagnosis for ${cls}`, () => {
      const html = renderToString(
        <RunDiagnosisPanel
          run={failedRun({
            errorClass: cls,
            errorExcerpt: "SOME ORCA ERROR LINE",
            inputPath: "/scratch/mol.inp",
          })}
        />,
      );
      const d = DIAGNOSES[cls];
      expect(html).toContain(d.title);
      // The cause paragraph is rendered (probe with a marker-free prefix —
      // renderToString HTML-escapes quotes, so match a safe slice).
      expect(html).toContain(d.cause.slice(0, 40));
      // Every link goes out in a new tab with its href intact.
      for (const link of d.links) {
        expect(html).toContain(`href="${link.href}"`);
        expect(html).toContain(link.label);
      }
      expect(html).toContain('target="_blank"');
      expect(html).toContain("SOME ORCA ERROR LINE");
    });
  }

  test("CLI remedy shows the command resolved against the run's own files", () => {
    const html = renderToString(
      <RunDiagnosisPanel
        run={failedRun({
          errorClass: "opt_max_cycles",
          inputPath: "/scratch/jobs/water_opt.inp",
        })}
      />,
    );
    expect(html).toContain("dftstream restart /scratch/jobs/water_opt.out");
    // Copy affordance is present next to the command.
    expect(html).toContain("Copy command");
  });

  test("CLI remedy keeps the honest placeholder when no input path is recorded", () => {
    const html = renderToString(
      <RunDiagnosisPanel run={failedRun({ errorClass: "opt_max_cycles" })} />,
    );
    expect(html).toContain("dftstream restart");
    expect(html).toContain("run.out");
  });

  test("severity note distinguishes large from small imaginary modes", () => {
    const html = renderToString(
      <RunDiagnosisPanel run={failedRun({ errorClass: "opt_max_cycles" })} />,
    );
    expect(html).toContain("50i");
  });

  test("failed run without an errorClass falls back to excerpt + manual link", () => {
    const html = renderToString(
      <RunDiagnosisPanel
        run={failedRun({ exitCode: 137, errorExcerpt: "KILLED BY SIGNAL 9" })}
      />,
    );
    expect(html).toContain("KILLED BY SIGNAL 9");
    expect(html).toContain("exit code 137");
    expect(html).toContain(MANUAL_TROUBLESHOOTING_LINK.href);
  });

  test("a class from a newer wrapper is humanized, not dropped", () => {
    const html = renderToString(
      <RunDiagnosisPanel
        run={failedRun({ errorClass: "quantum_decoherence_storm" })}
      />,
    );
    expect(html).toContain("quantum decoherence storm");
    expect(html).toContain(MANUAL_TROUBLESHOOTING_LINK.href);
  });

  test("renders nothing for runs that did not fail", () => {
    for (const status of ["pending", "running", "finished"] as const) {
      const html = renderToString(
        <RunDiagnosisPanel
          run={failedRun({ status, errorClass: "scf_not_converged" })}
        />,
      );
      expect(html).toBe("");
    }
  });

  test("long excerpts collapse behind a disclosure, short ones stay open", () => {
    const long = renderToString(
      <RunDiagnosisPanel
        run={failedRun({
          errorClass: "scf_not_converged",
          errorExcerpt: "X".repeat(400),
        })}
      />,
    );
    expect(long).toContain("<details");
    const short = renderToString(
      <RunDiagnosisPanel
        run={failedRun({
          errorClass: "scf_not_converged",
          errorExcerpt: "short line",
        })}
      />,
    );
    expect(short).not.toContain("<details");
  });
});
