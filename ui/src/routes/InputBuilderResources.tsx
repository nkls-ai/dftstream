import { useState } from "react";
import { usePrompt } from "../components/Confirm";
import {
  customOnly,
  NO_PROFILE_ID,
  profileIdFromName,
  saveCustomProfiles,
  type MachineProfile,
} from "../lib/inputBuilder/machineProfiles";
import { recommendedMaxCoreMB } from "../lib/inputBuilder/resources";
import type { Resources } from "../lib/inputBuilder/types";

/**
 * The machine the job is going to: cores, RAM and the queue's walltime
 * cap, picked from a profile rather than typed as a bare RAM number. The
 * profile is what the resource checks are run against — "%maxcore × 8 =
 * 24 GB" means nothing until something knows the machine has 16.
 */
export function InputBuilderResources({
  profiles,
  profileId,
  res,
  walltimeHours,
  onProfile,
  onProfiles,
  onRes,
  onWalltime,
}: {
  profiles: MachineProfile[];
  profileId: string;
  res: Resources;
  walltimeHours: number;
  onProfile: (id: string) => void;
  onProfiles: (next: MachineProfile[]) => void;
  onRes: (next: Resources) => void;
  onWalltime: (hours: number) => void;
}) {
  const prompt = usePrompt();
  const [error, setError] = useState("");
  const profile = profiles.find((p) => p.id === profileId) ?? null;
  const recommended = recommendedMaxCoreMB(profile?.ramMB ?? 0, res.nprocs);

  async function addProfile() {
    const name = await prompt({ title: "New machine profile", message: "Name", placeholder: "hpc-fat-node" });
    if (!name) return;
    // Cancelling any step (prompt → null) abandons the whole profile
    // silently; Number(null) would otherwise turn a cancel into 0.
    const coresRaw = await prompt({ title: "New machine profile", message: `Cores on ${name}`, defaultValue: "32" });
    if (coresRaw == null) return;
    const ramRaw = await prompt({ title: "New machine profile", message: `RAM in GB on ${name}`, defaultValue: "128" });
    if (ramRaw == null) return;
    const capRaw = await prompt({ title: "New machine profile", message: "Walltime cap in hours (0 = none)", defaultValue: "0" });
    if (capRaw == null) return;
    const cores = Number(coresRaw);
    const ramGB = Number(ramRaw);
    const capHours = Number(capRaw);
    if (!Number.isFinite(cores) || cores <= 0 || !Number.isFinite(ramGB) || ramGB <= 0) {
      setError("cores and RAM must be positive numbers — profile not saved");
      return;
    }
    const cluster = await prompt({
      title: "New machine profile",
      message: "clusters.yaml cluster name for `dftstream submit` (optional)",
      placeholder: "my-cluster",
    });
    if (cluster == null) return;
    const id = profileIdFromName(name) || `machine-${Date.now()}`;
    const next = [
      ...profiles.filter((p) => p.id !== id),
      {
        id,
        name,
        cores: Math.round(cores),
        ramMB: Math.round(ramGB * 1024),
        walltimeCapHours: Number.isFinite(capHours) && capHours > 0 ? capHours : 0,
        cluster,
      },
    ];
    // Only the user's own profiles are persisted; the bundled ones ship
    // with the build and would only go stale in the store.
    setError(
      saveCustomProfiles(customOnly(next))
        ? ""
        : "could not save the profile — browser storage is unavailable or full",
    );
    onProfiles(next);
    onProfile(id);
  }

  return (
    <>
      <label className="ib-field">
        <span>Machine</span>
        <select value={profileId} onChange={(e) => onProfile(e.target.value)}>
          <option value={NO_PROFILE_ID}>unknown machine (checks off)</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button type="button" className="dl-btn" onClick={() => void addProfile()}>
          Add a machine…
        </button>
        {profile && (
          <span className="dim">
            {profile.cores} cores · {Math.round(profile.ramMB / 1024)} GB
            {profile.walltimeCapHours > 0 ? ` · ${profile.walltimeCapHours} h cap` : ""}
            {profile.cluster ? ` · cluster ${profile.cluster}` : ""}
          </span>
        )}
        {error && <span className="ib-finding error">{error}</span>}
      </label>

      <label className="ib-field">
        <span>Cores (%pal)</span>
        <input
          type="number"
          min={0}
          value={res.nprocs}
          onChange={(e) => onRes({ ...res, nprocs: Number(e.target.value) })}
        />
        {profile && res.nprocs !== profile.cores && (
          <button type="button" className="dl-btn" onClick={() => onRes({ ...res, nprocs: profile.cores })}>
            use all {profile.cores}
          </button>
        )}
      </label>

      <label className="ib-field">
        <span>%maxcore (MB/core)</span>
        <input
          type="number"
          min={0}
          value={res.maxCoreMB}
          onChange={(e) => onRes({ ...res, maxCoreMB: Number(e.target.value) })}
        />
        {recommended > 0 && recommended !== res.maxCoreMB && (
          <button type="button" className="dl-btn" onClick={() => onRes({ ...res, maxCoreMB: recommended })}>
            use {recommended} (75% of RAM)
          </button>
        )}
      </label>

      <label className="ib-field">
        <span>Walltime (hours)</span>
        <input
          type="number"
          min={0}
          step="any"
          value={walltimeHours || ""}
          placeholder="the queue profile's own"
          onChange={(e) => onWalltime(Number(e.target.value))}
        />
        <span className="dim">
          Checked against the machine's cap. ORCA inputs carry no walltime — the scheduler profile does.
        </span>
      </label>
    </>
  );
}
