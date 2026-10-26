import { expect, test } from "bun:test";
import {
  renderFreqBlock,
  renderGeomScanBlock,
  renderMecpBlock,
  renderScanDimension,
  renderTddftBlock,
  scanProblems,
  trimFloat,
} from "./blocks";
import { ScanCoordId } from "./types";

// The Go renderers in wrapper/internal/inputbuild/blocks.go produce the
// same bytes for the same block; these expectations are copied from
// inputbuild_test.go on purpose, so a drift on either side shows up.

test("a scan entry reads like the group's own scan inputs", () => {
  expect(renderScanDimension({ coord: ScanCoordId.Bond, atoms: [0, 1], from: 1.1, to: 1.8, steps: 15 })).toBe(
    "B 0 1 = 1.10, 1.80, 15",
  );
  expect(renderScanDimension({ coord: ScanCoordId.Angle, atoms: [0, 1, 2], from: 100, to: 120.5, steps: 11 })).toBe(
    "A 0 1 2 = 100.00, 120.50, 11",
  );
  expect(
    renderScanDimension({ coord: ScanCoordId.Dihedral, atoms: [3, 2, 1, 0], from: -180, to: 180, steps: 37 }),
  ).toBe("D 3 2 1 0 = -180.00, 180.00, 37");
});

test("scan endpoints keep the precision they were given", () => {
  expect(trimFloat(1)).toBe("1.00");
  expect(trimFloat(1.1)).toBe("1.10");
  expect(trimFloat(109.471)).toBe("109.471");
});

test("the %geom scan block matches the Go renderer", () => {
  expect(renderGeomScanBlock({ coord: ScanCoordId.Bond, atoms: [0, 1], from: 1.1, to: 1.8, steps: 15 })).toBe(
    "%geom\n  Scan\n    B 0 1 = 1.10, 1.80, 15\n  end\nend",
  );
});

test("the %tddft block renders nothing without roots", () => {
  expect(renderTddftBlock({ nroots: 0, triplets: true })).toBe("");
  expect(renderTddftBlock({ nroots: 5, triplets: false })).toBe("%tddft\n  NRoots 5\nend");
  expect(renderTddftBlock({ nroots: 8, triplets: true })).toBe("%tddft\n  NRoots 8\n  Triplets true\nend");
});

test("the %mecp block renders nothing without a second multiplicity", () => {
  expect(renderMecpBlock({ mult2: 0 })).toBe("");
  expect(renderMecpBlock({ mult2: 3 })).toBe("%mecp\n  Mult 3\nend");
});

test("unset thermo conditions leave ORCA's own defaults alone", () => {
  expect(renderFreqBlock({ temperatureK: 0, pressureAtm: 0 })).toBe("");
  expect(renderFreqBlock({ temperatureK: 273.15, pressureAtm: 0 })).toBe("%freq\n  Temp 273.15\nend");
  expect(renderFreqBlock({ temperatureK: 310.15, pressureAtm: 2.5 })).toBe(
    "%freq\n  Temp 310.15\n  Pressure 2.50\nend",
  );
});

test("a scan that cannot run is refused before it is rendered", () => {
  const bad = scanProblems({ coord: ScanCoordId.Angle, atoms: [0, 1], from: 1, to: 2, steps: 5 }, 3);
  expect(bad.some((p) => p.includes("drives 3 atoms"))).toBe(true);

  const outOfRange = scanProblems({ coord: ScanCoordId.Bond, atoms: [0, 9], from: 1, to: 2, steps: 5 }, 3);
  expect(outOfRange.some((p) => p.includes("out of range"))).toBe(true);

  const repeated = scanProblems({ coord: ScanCoordId.Bond, atoms: [1, 1], from: 1, to: 2, steps: 5 }, 3);
  expect(repeated.some((p) => p.includes("repeated"))).toBe(true);

  const empty = scanProblems({ coord: ScanCoordId.Bond, atoms: [0, 1], from: 1.5, to: 1.5, steps: 5 }, 3);
  expect(empty.some((p) => p.includes("range is empty"))).toBe(true);

  const tooFew = scanProblems({ coord: ScanCoordId.Bond, atoms: [0, 1], from: 1, to: 2, steps: 1 }, 3);
  expect(tooFew.some((p) => p.includes("at least 2 points"))).toBe(true);
});

test("a valid scan reports nothing, and no structure means no index check", () => {
  const scan = { coord: ScanCoordId.Bond, atoms: [0, 1], from: 1.1, to: 1.8, steps: 15 };
  expect(scanProblems(scan, 4)).toEqual([]);
  // 0 atoms = no structure adopted yet; the index range is unknowable,
  // and "no structure yet" is already reported elsewhere.
  expect(scanProblems({ ...scan, atoms: [0, 99] }, 0)).toEqual([]);
});
