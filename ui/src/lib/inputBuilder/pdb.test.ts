import { expect, test } from "bun:test";
import { elementFromAtomName, parsePDB } from "./pdb";

/**
 * PDB is a column format, so the fixtures are assembled by column rather
 * than hand-padded — a fixture whose spacing drifts would test nothing.
 * Fields not named here stay blank, which is legal.
 */
function atomLine(fields: {
  record?: "ATOM" | "HETATM";
  serial?: number;
  /** Columns 13-16, padding included: " CA " ≠ "CA  ". */
  name: string;
  altLoc?: string;
  resName?: string;
  x: string;
  y: string;
  z: string;
  element?: string;
}): string {
  const cols = " ".repeat(80).split("");
  const put = (from: number, text: string) => {
    for (let i = 0; i < text.length; i++) cols[from - 1 + i] = text[i]!;
  };
  put(1, (fields.record ?? "ATOM").padEnd(6, " "));
  put(7, String(fields.serial ?? 1).padStart(5, " "));
  put(13, fields.name.padEnd(4, " ").slice(0, 4));
  put(17, fields.altLoc ?? " ");
  put(18, (fields.resName ?? "LIG").padEnd(3, " "));
  put(22, "A");
  put(23, "   1");
  put(31, fields.x.padStart(8, " "));
  put(39, fields.y.padStart(8, " "));
  put(47, fields.z.padStart(8, " "));
  put(55, "  1.00  0.00");
  if (fields.element) put(77, fields.element.padStart(2, " "));
  return cols.join("").trimEnd();
}

const WATER = [
  atomLine({ serial: 1, name: " O  ", resName: "HOH", x: "0.000", y: "0.000", z: "0.000", element: "O" }),
  atomLine({ serial: 2, name: " H1 ", resName: "HOH", x: "0.958", y: "0.000", z: "0.000", element: "H" }),
  atomLine({ serial: 3, name: " H2 ", resName: "HOH", x: "-0.240", y: "0.927", z: "0.000", element: "H" }),
  "END",
].join("\n");

test("ATOM records become atoms, element column first", () => {
  const res = parsePDB(WATER, "water.pdb");
  expect(res.errors).toEqual([]);
  expect(res.structure?.atoms.map((a) => a.el)).toEqual(["O", "H", "H"]);
  expect(res.structure?.atoms[1]).toEqual({ el: "H", x: 0.958, y: 0, z: 0 });
  expect(res.structure?.atoms[2]?.x).toBe(-0.24);
  expect(res.structure?.label).toBe("water.pdb");
});

test("HETATM records are read too — the ligand is usually the molecule", () => {
  const res = parsePDB(
    atomLine({
      record: "HETATM",
      serial: 2001,
      name: "FE  ",
      resName: "HEM",
      x: "12.345",
      y: "-23.456",
      z: "7.890",
      element: "FE",
    }),
  );
  expect(res.errors).toEqual([]);
  expect(res.structure?.atoms).toEqual([{ el: "Fe", x: 12.345, y: -23.456, z: 7.89 }]);
});

test("coordinates that touch each other still parse — columns, not spaces", () => {
  // Large negatives fill their fields completely and run together, which
  // is exactly where a whitespace-splitting parser would fall over.
  const line = atomLine({
    name: " C  ",
    x: "-123.456",
    y: "-234.567",
    z: "-345.678",
    element: "C",
  });
  expect(line.slice(30, 54)).toBe("-123.456-234.567-345.678");
  const res = parsePDB(line);
  expect(res.errors).toEqual([]);
  expect(res.structure?.atoms[0]).toEqual({ el: "C", x: -123.456, y: -234.567, z: -345.678 });
});

test("a missing element column falls back to the atom name, and says so", () => {
  const res = parsePDB(atomLine({ name: " CA ", resName: "ALA", x: "1.000", y: "2.000", z: "3.000" }));
  expect(res.structure?.atoms[0]?.el).toBe("C");
  expect(res.notes.some((n) => n.includes("no element column"))).toBe(true);
});

test("the atom-name columns distinguish calcium from an alpha carbon", () => {
  // The leading space in columns 13-14 IS the distinction.
  expect(elementFromAtomName(" CA ")).toBe("C");
  expect(elementFromAtomName("CA  ")).toBe("Ca");
  expect(elementFromAtomName(" C  ")).toBe("C");
  expect(elementFromAtomName("1HB ")).toBe("H");
  expect(elementFromAtomName("ZZ  ")).toBe("");
});

test("only the first model of an ensemble is read", () => {
  const text = [
    "MODEL        1",
    atomLine({ name: " O  ", resName: "HOH", x: "0.000", y: "0.000", z: "0.000", element: "O" }),
    "ENDMDL",
    "MODEL        2",
    atomLine({ name: " O  ", resName: "HOH", x: "9.000", y: "9.000", z: "9.000", element: "O" }),
    "ENDMDL",
  ].join("\n");
  const res = parsePDB(text);
  expect(res.structure?.atoms.length).toBe(1);
  expect(res.structure?.atoms[0]?.x).toBe(0);
  expect(res.notes.some((n) => n.includes("several models"))).toBe(true);
});

test("alternate conformations do not stack two atoms on one position", () => {
  const text = [
    atomLine({ serial: 1, name: " CB ", altLoc: "A", resName: "SER", x: "1.000", y: "0.000", z: "0.000", element: "C" }),
    atomLine({ serial: 2, name: " CB ", altLoc: "B", resName: "SER", x: "1.500", y: "0.000", z: "0.000", element: "C" }),
  ].join("\n");
  const res = parsePDB(text);
  expect(res.structure?.atoms.length).toBe(1);
  expect(res.structure?.atoms[0]?.x).toBe(1);
  expect(res.notes.some((n) => n.includes("alternate-location"))).toBe(true);
});

test("a hydrogen-free crystal structure is flagged, not silently accepted", () => {
  const res = parsePDB(atomLine({ name: " C  ", x: "0.000", y: "0.000", z: "0.000", element: "C" }));
  expect(res.notes.some((n) => n.includes("no hydrogens"))).toBe(true);
});

test("a file with no coordinate records is an error, never an empty molecule", () => {
  const res = parsePDB("HEADER    NOTHING HERE\nEND");
  expect(res.structure).toBeNull();
  expect(res.errors[0]).toContain("no ATOM or HETATM");
});

test("an unreadable element or coordinate is reported, never guessed", () => {
  const badElement = atomLine({ name: " XX ", x: "0.000", y: "0.000", z: "0.000", element: "Xx" });
  expect(parsePDB(badElement).errors[0]).toContain("not an element symbol");

  const badCoords = atomLine({ name: " C  ", x: "n/a", y: "n/a", z: "n/a", element: "C" });
  expect(parsePDB(badCoords).errors[0]).toContain("cannot read coordinates");
});
