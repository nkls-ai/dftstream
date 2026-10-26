import { describe, expect, test } from "bun:test";
import {
  buildToolsEnergySeries,
  isSupportedLocalFile,
  localFileUrl,
  parseLoadedTraj,
} from "./toolsLocalFile";

const TRAJ = `3
Coordinates from ORCA-job x E  -5.504066223030
C 0 0 0
N 0 0 1.1
H 0 0 2.1
3
Coordinates from ORCA-job x E  -5.477647814220
C 0 0 0
N 0 0 1.2
H 0 0 2.2
`;

describe("parseLoadedTraj", () => {
  test("splits frames and pulls comment-line energies", () => {
    const { frames, energies } = parseLoadedTraj(TRAJ);
    expect(frames).toHaveLength(2);
    expect(energies[0]).toBeCloseTo(-5.504066223030, 9);
    expect(energies[1]).toBeCloseTo(-5.477647814220, 9);
  });

  test("tolerates frames without an energy", () => {
    const { frames, energies } = parseLoadedTraj("1\nno numbers here\nH 0 0 0\n");
    expect(frames).toHaveLength(1);
    expect(energies[0]).toBeUndefined();
  });

  test("empty input", () => {
    expect(parseLoadedTraj("").frames).toHaveLength(0);
  });
});

describe("buildToolsEnergySeries", () => {
  test("absolute keeps Eh values", () => {
    const s = buildToolsEnergySeries([-5.5, -5.4], false);
    expect(s).toEqual([
      { x: 0, y: -5.5 },
      { x: 1, y: -5.4 },
    ]);
  });

  test("relative rebases to min in kcal/mol and skips gaps", () => {
    const s = buildToolsEnergySeries([-5.5, undefined, -5.4], true);
    expect(s).toHaveLength(2);
    expect(s[0]).toEqual({ x: 0, y: 0 });
    expect(s[1]!.x).toBe(2);
    expect(s[1]!.y).toBeCloseTo(0.1 * 627.5094740631, 6);
  });

  test("empty when no energies", () => {
    expect(buildToolsEnergySeries([undefined, undefined], true)).toEqual([]);
  });
});

test("localFileUrl escapes the path", () => {
  expect(localFileUrl("/data/my run/a.xyz")).toBe(
    "/api/local-file?path=%2Fdata%2Fmy%20run%2Fa.xyz",
  );
});

test("isSupportedLocalFile matches the Go allowlist", () => {
  expect(isSupportedLocalFile("/a/b.xyz")).toBe(true);
  expect(isSupportedLocalFile("/a/b_trj.TRJ ")).toBe(true);
  expect(isSupportedLocalFile("/a/b.interp")).toBe(true);
  expect(isSupportedLocalFile("/a/b.gbw")).toBe(false);
});
