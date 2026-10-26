import { describe, expect, test } from "bun:test";
import type { Run } from "../data/types";
import { lowestEnergyRun } from "./runSelect";

function run(id: string, lastEnergy?: number): Run {
  return { id, status: "finished", lastEnergy } as Run;
}

describe("lowestEnergyRun", () => {
  test("picks the most negative energy", () => {
    const r = lowestEnergyRun([run("a", -1.5), run("b", -2.5), run("c", -2.0)]);
    expect(r.id).toBe("b");
  });

  test("single run returns itself", () => {
    expect(lowestEnergyRun([run("a", -1)]).id).toBe("a");
  });

  test("missing energy counts as 0 and loses to any negative energy", () => {
    expect(lowestEnergyRun([run("a"), run("b", -0.1)]).id).toBe("b");
  });

  test("keeps the later run on ties (strict less-than)", () => {
    expect(lowestEnergyRun([run("a", -1), run("b", -1)]).id).toBe("b");
  });
});
