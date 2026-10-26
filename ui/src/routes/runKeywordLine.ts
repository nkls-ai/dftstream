import type { Run } from "../data/types";

/**
 * The run's ORCA simple-input line ("! B3LYP def2-SVP Opt Freq …").
 * Reconstructed from the parsed keyword tokens; for legacy runs without
 * them, the first `!` line of the stored input text. Null when neither
 * source exists.
 */
export function runKeywordLine(r: Run): string | null {
  if (r.keywords?.length) return "! " + r.keywords.join(" ");
  if (r.inputText) {
    for (const line of r.inputText.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("!")) return trimmed;
    }
  }
  return null;
}
