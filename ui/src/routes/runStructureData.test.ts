import { describe, expect, test } from "bun:test";
import {
  atomTileColors,
  bondOrderBar,
  buildCubeIdsByCycle,
  buildEnergyData,
  buildExtraCube,
  buildOrbitalEntry,
  buildVibModeMap,
  hasPerCycleCubes,
  isScanInput,
  pickNonOrbitalCubes,
  resolveActiveCubeIds,
  sortGeometriesByCycle,
} from "./runStructureData";
import type { CubeMeta } from "../data/DataSource";

const cube = (id: string, name: string, createdAt = 0): CubeMeta => ({
  id,
  name,
  createdAt,
  sizeBytes: 0,
});

describe("sortGeometriesByCycle", () => {
  test("sorts a copy by cycle", () => {
    const input = [
      { cycle: 3, ts: 3, xyz: "c" },
      { cycle: 1, ts: 1, xyz: "a" },
      { cycle: 2, ts: 2, xyz: "b" },
    ];
    const out = sortGeometriesByCycle(input);
    expect(out.map((g) => g.cycle)).toEqual([1, 2, 3]);
    // input untouched
    expect(input.map((g) => g.cycle)).toEqual([3, 1, 2]);
  });
  test("undefined yields empty", () => {
    expect(sortGeometriesByCycle(undefined)).toEqual([]);
  });
});

describe("buildEnergyData", () => {
  test("dedupes by cycle (last value wins) and sorts", () => {
    const pts = [
      { ts: 0, cycle: 2, value: -2.0 },
      { ts: 1, cycle: 1, value: -1.0 },
      { ts: 2, cycle: 2, value: -2.5 },
    ];
    expect(buildEnergyData(pts, new Set([1, 2]))).toEqual([
      { x: 1, y: -1.0 },
      { x: 2, y: -2.5 },
    ]);
  });
  test("filters to geometry cycles when the set is non-empty", () => {
    const pts = [
      { ts: 0, cycle: 1, value: -1.0 },
      { ts: 1, cycle: 9, value: -9.0 },
    ];
    expect(buildEnergyData(pts, new Set([1]))).toEqual([{ x: 1, y: -1.0 }]);
  });
  test("keeps everything when there are no geometry cycles", () => {
    const pts = [{ ts: 0, cycle: 9, value: -9.0 }];
    expect(buildEnergyData(pts, new Set())).toEqual([{ x: 9, y: -9.0 }]);
  });
  test("missing cycle buckets under 0", () => {
    const pts = [{ ts: 0, value: -3.0 }];
    expect(buildEnergyData(pts, new Set())).toEqual([{ x: 0, y: -3.0 }]);
  });
  test("undefined points yield empty", () => {
    expect(buildEnergyData(undefined, new Set())).toEqual([]);
  });
});

describe("buildVibModeMap", () => {
  test("keys by extracted mode index, skips unparseable names", () => {
    const m = buildVibModeMap([
      { id: "a", name: "run.v6.xyz", contentText: "six" },
      { id: "b", name: "run.v12.xyz", contentText: "twelve" },
      { id: "c", name: "run.trj.xyz", contentText: "nope" },
    ]);
    expect(m.get(6)).toBe("six");
    expect(m.get(12)).toBe("twelve");
    expect(m.size).toBe(2);
  });
});

describe("buildCubeIdsByCycle", () => {
  test("groups by cycle with 'final' for cycle-less cubes, dedupes MO", () => {
    const m = buildCubeIdsByCycle([
      cube("h3", "run.c3.mo11a.cube"),
      cube("l3", "run.c3.mo12a.cube"),
      cube("h3dup", "run.c3.mo11b.cube"),
      cube("hf", "run.mo11a.cube"),
      cube("dens", "run.eldens.cube"),
    ]);
    expect(m.get(3)?.map((e) => e.id)).toEqual(["h3", "l3"]);
    expect(m.get("final")?.map((e) => e.id)).toEqual(["hf"]);
    expect(m.size).toBe(2);
  });
});

describe("resolveActiveCubeIds", () => {
  const map = buildCubeIdsByCycle([
    cube("h2", "run.c2.mo11a.cube"),
    cube("l2", "run.c2.mo12a.cube"),
    cube("h5", "run.c5.mo11a.cube"),
    cube("l5", "run.c5.mo12a.cube"),
    cube("hf", "run.mo11a.cube"),
    cube("lf", "run.mo12a.cube"),
  ]);
  test("exact cycle match", () => {
    expect(resolveActiveCubeIds(map, 5)).toEqual({
      homoId: "h5",
      lumoId: "l5",
      homoName: "run.c5.mo11a.cube",
      lumoName: "run.c5.mo12a.cube",
    });
  });
  test("nearest numeric cycle when no exact match", () => {
    expect(resolveActiveCubeIds(map, 3).homoId).toBe("h2");
    expect(resolveActiveCubeIds(map, 100).homoId).toBe("h5");
  });
  test("final fallback when only final cubes exist", () => {
    const finalOnly = buildCubeIdsByCycle([
      cube("hf", "run.mo11a.cube"),
      cube("lf", "run.mo12a.cube"),
    ]);
    expect(resolveActiveCubeIds(finalOnly, 7)).toEqual({
      homoId: "hf",
      lumoId: "lf",
      homoName: "run.mo11a.cube",
      lumoName: "run.mo12a.cube",
    });
  });
  test("single cube: lumo suppressed rather than duplicated", () => {
    const single = buildCubeIdsByCycle([cube("hf", "run.mo11a.cube")]);
    const r = resolveActiveCubeIds(single, undefined);
    expect(r.homoId).toBe("hf");
    expect(r.lumoId).toBeNull();
  });
  test("empty map yields nulls", () => {
    expect(resolveActiveCubeIds(new Map(), 1)).toEqual({
      homoId: null,
      lumoId: null,
      homoName: "",
      lumoName: "",
    });
  });
});

describe("hasPerCycleCubes / pickNonOrbitalCubes", () => {
  test("detects per-cycle cube names", () => {
    expect(hasPerCycleCubes([cube("a", "run.c1.mo11a.cube")])).toBe(true);
    expect(hasPerCycleCubes([cube("a", "run.mo11a.cube")])).toBe(false);
    expect(hasPerCycleCubes(undefined)).toBe(false);
  });
  test("non-orbital cubes: newest first, capped at 4", () => {
    const cubes = [
      cube("mo", "run.mo11a.cube", 99),
      cube("d1", "run.eldens.cube", 1),
      cube("d2", "run.esp.cube", 2),
      cube("d3", "run.f0.cube", 3),
      cube("d4", "run.f1.cube", 4),
      cube("d5", "run.f2.cube", 5),
    ];
    expect(pickNonOrbitalCubes(cubes).map((c) => c.id)).toEqual([
      "d5",
      "d4",
      "d3",
      "d2",
    ]);
  });
});

describe("buildOrbitalEntry", () => {
  test("null id yields null", () => {
    expect(buildOrbitalEntry(null, "x", "body", 11, 12)).toBeNull();
  });
  test("HOMO labeling and default colors", () => {
    expect(buildOrbitalEntry("a", "run.mo11a.cube", "body", 11, 12)).toEqual({
      id: "a",
      kind: "homo",
      label: "HOMO (MO 11)",
      cube: "body",
      lobes: "occupied",
    });
  });
  test("LUMO labeling swaps the color pair", () => {
    expect(buildOrbitalEntry("b", "run.mo12a.cube", undefined, 11, 12)).toEqual({
      id: "b",
      kind: "lumo",
      label: "LUMO (MO 12)",
      cube: "",
      lobes: "lumo",
    });
  });
  test("plain MO when index matches neither frontier orbital", () => {
    const e = buildOrbitalEntry("c", "run.mo9a.cube", "x", 11, 12);
    expect(e?.label).toBe("MO 9");
    expect(e?.kind).toBe("mo9");
  });
  test("name without MO index keeps the raw name", () => {
    const e = buildOrbitalEntry("d", "weird.cube", "x", undefined, undefined);
    expect(e?.label).toBe("weird.cube");
    expect(e?.kind).toBe("weird.cube");
  });
});

describe("buildExtraCube", () => {
  test("strips path + .cube extension into the label", () => {
    const e = buildExtraCube(cube("d", "sub/dir/run.eldens.CUBE"), "body");
    expect(e).toEqual({
      id: "d",
      kind: "prop-run.eldens",
      label: "run.eldens",
      cube: "body",
      lobes: "property",
    });
  });
  test("missing body becomes empty string", () => {
    expect(buildExtraCube(cube("d", "a.cube"), undefined).cube).toBe("");
  });
});

describe("isScanInput", () => {
  test("matches a Scan line anywhere, case-insensitive, with indent", () => {
    expect(isScanInput("%geom\n  Scan\n  B 0 1 = 1.0, 2.0, 5\n  end\nend")).toBe(
      true,
    );
    expect(isScanInput("! Opt B3LYP")).toBe(false);
    expect(isScanInput(undefined)).toBe(false);
  });
  test("does not match Scan mid-line", () => {
    expect(isScanInput("# relaxed Scan below")).toBe(false);
  });
});

describe("atomTileColors", () => {
  test("neutral atom gets baseline pink alphas", () => {
    expect(atomTileColors(0)).toEqual({
      bg: "rgba(244, 114, 182, 0.1)",
      border: "rgba(244, 114, 182, 0.32)",
    });
  });
  test("negative charge maps to blue, positive to pink", () => {
    expect(atomTileColors(-1)).toEqual({
      bg: "rgba(96, 165, 250, 0.6)",
      border: "rgba(96, 165, 250, 0.62)",
    });
    expect(atomTileColors(1).bg).toBe("rgba(244, 114, 182, 0.6)");
  });
  test("clamps beyond ±1", () => {
    expect(atomTileColors(-3)).toEqual(atomTileColors(-1));
    expect(atomTileColors(3)).toEqual(atomTileColors(1));
  });
});

describe("bondOrderBar", () => {
  test("full bar at order 3+, strong at 1.5", () => {
    expect(bondOrderBar(3)).toEqual({ barWidth: "100%", isStrong: true });
    expect(bondOrderBar(4)).toEqual({ barWidth: "100%", isStrong: true });
    expect(bondOrderBar(1.5).isStrong).toBe(true);
    expect(bondOrderBar(1.49).isStrong).toBe(false);
  });
  test("minimum 8% width for tiny orders", () => {
    expect(bondOrderBar(0.01).barWidth).toBe("8%");
  });
  test("proportional width", () => {
    expect(bondOrderBar(1.5).barWidth).toBe("50%");
  });
});
