import { useMemo } from "react";
import type { OrbitalCube } from "../components/StructureViewer";
import { useDataSource } from "../data/DataSource";
import {
  buildCubeIdsByCycle,
  buildExtraCube,
  buildOrbitalEntry,
  hasPerCycleCubes,
  pickNonOrbitalCubes,
  resolveActiveCubeIds,
} from "./runStructureData";

export interface RunStructureCubes {
  /** Viewer entries for the active HOMO/LUMO cubes plus any non-orbital
   *  (density, ESP, ...) cubes. Empty while nothing is available. */
  orbitals: OrbitalCube[];
  /** True when per-cycle orbital cubes were captured for this run. */
  hasPerCycle: boolean;
}

/**
 * Cube index + body fetching for the Structure tab.
 *
 * The index query is metadata only (id + name). Fetching every cube body in
 * one query would blow past Convex's 16 MiB per-query read budget once
 * per-cycle cubes are in play (e.g. 20 × ~900 KB). We fetch the body of
 * exactly the two cubes (HOMO + LUMO) belonging to the currently displayed
 * opt cycle, resolved exact → nearest numeric → final fallback. Each body
 * fetch is its own Convex subscription that's cached/deduped, so flipping
 * back and forth between cycles after the first visit is instant.
 *
 * Up to 4 non-orbital cubes are fetched eagerly (they're only present when
 * explicitly computed, so count is low).
 */
export function useRunStructureCubes(
  runId: string,
  targetCycle: number | undefined,
  homoMO: number | undefined,
  lumoMO: number | undefined,
): RunStructureCubes {
  const ds = useDataSource();
  const cubeIndex = ds.useRunCubeIndex(runId);
  const hasPerCycle = useMemo(
    () => hasPerCycleCubes(cubeIndex.data),
    [cubeIndex.data],
  );

  // Build cycle → [HOMO id, LUMO id] map. When per-cycle is off there's
  // just one entry under "final".
  const cubeIdsByCycle = useMemo(
    () => buildCubeIdsByCycle(cubeIndex.data),
    [cubeIndex.data],
  );

  // Resolve which two cubes we want for the displayed cycle.
  const activeCubeIds = useMemo(
    () => resolveActiveCubeIds(cubeIdsByCycle, targetCycle),
    [cubeIdsByCycle, targetCycle],
  );

  // Fetch the two cube bodies lazily.
  const homoContent = ds.useArtifactContent(activeCubeIds.homoId);
  const lumoContent = ds.useArtifactContent(activeCubeIds.lumoId);

  // Non-orbital cubes (density, ESP, Fukui, etc.) — no MO index in filename.
  const nonOrbitalCubes = useMemo(
    () => pickNonOrbitalCubes(cubeIndex.data),
    [cubeIndex.data],
  );
  const ec0 = ds.useArtifactContent(nonOrbitalCubes[0]?.id ?? null);
  const ec1 = ds.useArtifactContent(nonOrbitalCubes[1]?.id ?? null);
  const ec2 = ds.useArtifactContent(nonOrbitalCubes[2]?.id ?? null);
  const ec3 = ds.useArtifactContent(nonOrbitalCubes[3]?.id ?? null);
  const ecBodies = [ec0, ec1, ec2, ec3];
  const extraCubes: OrbitalCube[] = useMemo(() => {
    return nonOrbitalCubes.map((c, i) =>
      buildExtraCube(c, ecBodies[i]?.data?.contentText),
    );
    // ecBodies is rebuilt every render; the fetched bodies are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonOrbitalCubes, ec0.data, ec1.data, ec2.data, ec3.data]);

  const orbitals: OrbitalCube[] = useMemo(() => {
    if (cubeIdsByCycle.size === 0 && extraCubes.length === 0) return [];
    // The orbital entry is created even while its body is still loading
    // (empty cube string). Keeping the entry alive across cycles stops
    // the toolbar dropdown + opacity slider from flickering as the loop
    // advances through opt cycles.
    const out: OrbitalCube[] = [];
    const h = buildOrbitalEntry(
      activeCubeIds.homoId,
      activeCubeIds.homoName,
      homoContent.data?.contentText,
      homoMO,
      lumoMO,
    );
    if (h) out.push(h);
    const l = buildOrbitalEntry(
      activeCubeIds.lumoId,
      activeCubeIds.lumoName,
      lumoContent.data?.contentText,
      homoMO,
      lumoMO,
    );
    if (l) out.push(l);
    // Include non-orbital cubes (density, ESP, etc.) — those without MO index
    for (const c of extraCubes) {
      out.push(c);
    }
    return out;
  }, [
    cubeIdsByCycle,
    activeCubeIds,
    homoContent.data,
    lumoContent.data,
    homoMO,
    lumoMO,
    extraCubes,
  ]);

  return { orbitals, hasPerCycle };
}
