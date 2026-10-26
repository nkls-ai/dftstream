import { describe, expect, test } from "bun:test";
import { filterArtifacts, sortArtifacts, type ArtifactListItem } from "./artifactListView";

function mk(name: string, kind: string, sizeBytes: number): ArtifactListItem {
  return { name, kind, sizeBytes };
}

const items = [
  mk("water.out", "output", 5000),
  mk("water.inp", "input", 300),
  mk("water.eldens.cube", "cube", 900_000),
  mk("notes.txt", "other", 42),
];

describe("filterArtifacts", () => {
  test("blank or whitespace query returns the input unchanged", () => {
    expect(filterArtifacts(items, "")).toBe(items);
    expect(filterArtifacts(items, "   ")).toBe(items);
  });

  test("matches name case-insensitively and trims the query", () => {
    expect(filterArtifacts(items, "WATER.I").map((a) => a.name)).toEqual(["water.inp"]);
    expect(filterArtifacts(items, "  cube ").map((a) => a.name)).toEqual(["water.eldens.cube"]);
  });

  test("no match yields an empty list", () => {
    expect(filterArtifacts(items, "hessian")).toEqual([]);
  });
});

describe("sortArtifacts", () => {
  test("kind mode orders by display kind rank, then name", () => {
    expect(sortArtifacts(items, "kind").map((a) => a.name)).toEqual([
      "water.inp",
      "water.out",
      "water.eldens.cube",
      "notes.txt",
    ]);
  });

  test("kind mode puts unknown kinds last and breaks ties by name", () => {
    const mixed = [mk("b.bin", "mystery", 1), mk("a.bin", "mystery", 2), mk("x.inp", "input", 3)];
    expect(sortArtifacts(mixed, "kind").map((a) => a.name)).toEqual(["x.inp", "a.bin", "b.bin"]);
  });

  test("name mode sorts A-Z", () => {
    expect(sortArtifacts(items, "name").map((a) => a.name)).toEqual([
      "notes.txt",
      "water.eldens.cube",
      "water.inp",
      "water.out",
    ]);
  });

  test("size mode sorts largest first with name tiebreak", () => {
    const tied = [...items, mk("aaa.log", "other", 5000)];
    expect(sortArtifacts(tied, "size").map((a) => a.name)).toEqual([
      "water.eldens.cube",
      "aaa.log",
      "water.out",
      "water.inp",
      "notes.txt",
    ]);
  });

  test("does not mutate the input array", () => {
    const copy = items.slice();
    sortArtifacts(items, "name");
    expect(items).toEqual(copy);
  });
});
