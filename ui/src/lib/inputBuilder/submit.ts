/**
 * The `dftstream submit` handoff. The builder produces a file and the
 * exact command that submits it — no deeper coupling: queue submission
 * (P1-2) owns the actual job, and a command a chemist can read, edit and
 * paste is the contract that keeps working either way.
 */

/** Characters that are safe unquoted in a POSIX shell word. */
const SAFE_WORD = /^[A-Za-z0-9._\-/=:]+$/;

/** Quotes a shell argument when it needs it (single quotes, escaped). */
export function shellQuote(value: string): string {
  if (value === "") return "''";
  if (SAFE_WORD.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface SubmitCommandOptions {
  fileName: string;
  /** clusters.yaml cluster name; "" uses the config's default_cluster. */
  cluster?: string;
  /** Queue profile (partition + walltime) from the cluster config; ""
   *  uses the cluster's default_profile. The walltime itself is NOT a
   *  submit flag — it belongs to the profile. */
  profile?: string;
}

/**
 * The command line that submits this input. Every value is shell-quoted:
 * a file name with a space must not become two arguments.
 */
export function submitCommand({ fileName, cluster = "", profile = "" }: SubmitCommandOptions): string {
  const parts = ["dftstream", "submit", shellQuote(fileName)];
  if (cluster.trim()) parts.push("--cluster", shellQuote(cluster.trim()));
  if (profile.trim()) parts.push("--profile", shellQuote(profile.trim()));
  return parts.join(" ");
}
