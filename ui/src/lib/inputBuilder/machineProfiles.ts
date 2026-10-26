/**
 * Machine profiles: the target machine's cores / RAM / walltime cap,
 * so the resource checks run against a named machine instead of a
 * free-typed RAM number. A few sensible defaults ship built in; the
 * user's own profiles persist in localStorage.
 */
import { STORAGE_KEYS } from "../storageKeys";
import { readJson, writeJson } from "../persistedJson";

export interface MachineProfile {
  id: string;
  name: string;
  cores: number;
  ramMB: number;
  /** Longest job the machine's queue allows; 0 = no cap. */
  walltimeCapHours: number;
  /** clusters.yaml cluster name for `dftstream submit --cluster`; "" uses
   *  the config's default_cluster. */
  cluster: string;
}

/** Profile id meaning "no profile selected" (resource checks off). */
export const NO_PROFILE_ID = "";

export const BUNDLED_PROFILES: readonly MachineProfile[] = [
  { id: "laptop", name: "Laptop (8 cores, 16 GB)", cores: 8, ramMB: 16 * 1024, walltimeCapHours: 0, cluster: "" },
  { id: "workstation", name: "Workstation (16 cores, 64 GB)", cores: 16, ramMB: 64 * 1024, walltimeCapHours: 0, cluster: "" },
  { id: "cluster-node", name: "Cluster node (32 cores, 128 GB)", cores: 32, ramMB: 128 * 1024, walltimeCapHours: 72, cluster: "" },
];

function isProfile(v: unknown): v is MachineProfile {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.id === "string" && p.id !== "" &&
    typeof p.name === "string" &&
    typeof p.cores === "number" && Number.isFinite(p.cores) &&
    typeof p.ramMB === "number" && Number.isFinite(p.ramMB) &&
    typeof p.walltimeCapHours === "number" && Number.isFinite(p.walltimeCapHours) &&
    typeof p.cluster === "string"
  );
}

/** The user's own profiles; a broken store degrades to none. */
export function loadCustomProfiles(): MachineProfile[] {
  // readJson degrades unavailable storage / corrupted JSON to undefined —
  // the bundled profiles still work, so a broken store means "none".
  const parsed = readJson(STORAGE_KEYS.machineProfiles);
  return Array.isArray(parsed) ? parsed.filter(isProfile) : [];
}

/** False when storage refused the write (full or disabled); the caller shows the failure. */
export function saveCustomProfiles(profiles: MachineProfile[]): boolean {
  return writeJson(STORAGE_KEYS.machineProfiles, profiles);
}

/** Bundled defaults + the user's own, custom ones shadowing same-id defaults. */
export function allProfiles(custom: MachineProfile[] = loadCustomProfiles()): MachineProfile[] {
  const customIds = new Set(custom.map((p) => p.id));
  return [...BUNDLED_PROFILES.filter((p) => !customIds.has(p.id)), ...custom];
}

/** The profiles that are the user's own, i.e. the ones worth persisting
 *  (a bundled profile ships with the build; storing a copy only lets it
 *  go stale). A bundled id the user has edited counts as their own. */
export function customOnly(profiles: MachineProfile[]): MachineProfile[] {
  return profiles.filter((p) => {
    const bundled = BUNDLED_PROFILES.find((b) => b.id === p.id);
    if (!bundled) return true;
    return (
      bundled.name !== p.name ||
      bundled.cores !== p.cores ||
      bundled.ramMB !== p.ramMB ||
      bundled.walltimeCapHours !== p.walltimeCapHours ||
      bundled.cluster !== p.cluster
    );
  });
}

export function profileById(id: string, profiles: MachineProfile[] = allProfiles()): MachineProfile | null {
  if (id === NO_PROFILE_ID) return null;
  return profiles.find((p) => p.id === id) ?? null;
}

/** A url/flag-safe id from a user-typed profile name. */
export function profileIdFromName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Resource problems only the profile knows about — the ones that never
 * appear in the input text, i.e. the walltime. The %maxcore × RAM and
 * nprocs × cores checks live in lint, fed with the profile's numbers, so
 * they keep following the (possibly hand-edited) input text.
 */
export function profileProblems(
  profile: MachineProfile | null,
  walltimeHours: number,
): string[] {
  const out: string[] = [];
  if (!profile) return out;
  if (profile.walltimeCapHours > 0 && walltimeHours > profile.walltimeCapHours) {
    out.push(
      `walltime ${walltimeHours} h exceeds the ${profile.walltimeCapHours} h cap of ${profile.name} — ` +
        `the scheduler will reject or silently truncate the job`,
    );
  }
  return out;
}
