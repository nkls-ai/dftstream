import { expect, test } from "bun:test";
import { atomLine, renderInput, renderResources, renderXYZFile } from "./render";
import { SolventModelId, StructureSource, type Atom, type InputSpec } from "./types";

const water: Atom[] = [
  { el: "O", x: 0, y: 0, z: 0 },
  { el: "H", x: 0.9584, y: 0, z: 0 },
  { el: "H", x: -0.2396, y: 0.9267, z: 0 },
];

function spec(over: Partial<InputSpec> = {}): InputSpec {
  return {
    keywords: ["r2SCAN-3c", "Opt", "Freq"],
    env: { charge: 0, multiplicity: 1, model: SolventModelId.None, solvent: "" },
    res: { nprocs: 8, maxCoreMB: 3000 },
    blocks: [],
    structure: { atoms: water, source: StructureSource.Pasted, label: "" },
    xyzFileName: null,
    ...over,
  };
}

test("the rendered input matches the wrapper's layout byte for byte", () => {
  // Identical to what inputbuild.Input.Render() produces for the same
  // job — including the %14.8f coordinate columns.
  expect(renderInput(spec())).toBe(
    `! r2SCAN-3c Opt Freq
%pal nprocs 8 end
%maxcore 3000
* xyz 0 1
O       0.00000000     0.00000000     0.00000000
H       0.95840000     0.00000000     0.00000000
H      -0.23960000     0.92670000     0.00000000
*
`,
  );
});

test("unset resources leave their lines out entirely", () => {
  expect(renderResources({ nprocs: 0, maxCoreMB: 0 })).toBe("");
  expect(renderInput(spec({ res: { nprocs: 0, maxCoreMB: 0 } })).split("\n")[1]).toBe("* xyz 0 1");
});

test("blocks render in order, each newline-terminated exactly once", () => {
  const out = renderInput(spec({ blocks: ["%geom\n  Calc_Hess true\nend", "%scf MaxIter 300 end\n", "  "] }));
  expect(out).toContain("%geom\n  Calc_Hess true\nend\n%scf MaxIter 300 end\n* xyz");
});

test("an xyzfile reference replaces the inline block", () => {
  const out = renderInput(spec({ xyzFileName: "start.xyz" }));
  expect(out).toContain("* xyzfile 0 1 start.xyz\n");
  expect(out).not.toContain("* xyz 0 1");
});

test("charge and multiplicity reach the coordinate header", () => {
  const out = renderInput(
    spec({ env: { charge: -2, multiplicity: 3, model: SolventModelId.None, solvent: "" } }),
  );
  expect(out).toContain("* xyz -2 3\n");
});

test("a non-finite coordinate renders as 0 rather than NaN", () => {
  // NaN in the file makes ORCA abort with a parse error at submit time;
  // the linter is what tells the user, not a corrupt input.
  expect(atomLine({ el: "C", x: NaN, y: Infinity, z: 1 })).toBe(
    "C       0.00000000     0.00000000     1.00000000\n",
  );
});

test("a standalone xyz file carries the count and comment", () => {
  expect(renderXYZFile("from SMILES: O", water.slice(0, 2))).toBe(
    `2
from SMILES: O
O       0.00000000     0.00000000     0.00000000
H       0.95840000     0.00000000     0.00000000
`,
  );
});
