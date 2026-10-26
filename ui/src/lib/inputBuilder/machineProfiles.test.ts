import { afterEach, expect, test } from "bun:test";
import {
  allProfiles,
  BUNDLED_PROFILES,
  customOnly,
  loadCustomProfiles,
  NO_PROFILE_ID,
  profileById,
  profileIdFromName,
  profileProblems,
  saveCustomProfiles,
  type MachineProfile,
} from "./machineProfiles";
import { STORAGE_KEYS } from "../storageKeys";

const KEY = STORAGE_KEYS.machineProfiles;

/** Replaces globalThis.localStorage for one test; returns the restorer. */
function withStorage(store: Storage | undefined): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { value: store, configurable: true });
  return () => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis as object, "localStorage");
  };
}

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  } as Storage;
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

const CUSTOM: MachineProfile = {
  id: "hpc",
  name: "HPC fat node",
  cores: 64,
  ramMB: 512 * 1024,
  walltimeCapHours: 48,
  cluster: "my-cluster",
};

test("saved profiles round-trip and shadow a bundled id", () => {
  restore = withStorage(memoryStorage());
  expect(saveCustomProfiles([CUSTOM])).toBe(true);
  expect(loadCustomProfiles()).toEqual([CUSTOM]);

  const all = allProfiles([CUSTOM]);
  expect(all).toContain(CUSTOM);
  expect(all.length).toBe(BUNDLED_PROFILES.length + 1);

  const shadow = { ...CUSTOM, id: "laptop", name: "My laptop" };
  const shadowed = allProfiles([shadow]);
  expect(shadowed.filter((p) => p.id === "laptop")).toEqual([shadow]);
});

test("a store that throws degrades to the bundled profiles, never a blank page", () => {
  const hostile = {
    getItem: () => {
      throw new Error("SecurityError: storage disabled");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  } as unknown as Storage;
  restore = withStorage(hostile);
  expect(loadCustomProfiles()).toEqual([]);
  expect(saveCustomProfiles([CUSTOM])).toBe(false);
  expect(allProfiles([])).toEqual([...BUNDLED_PROFILES]);
});

test("corrupted or half-typed stored rows are dropped, never trusted", () => {
  restore = withStorage(
    memoryStorage({ [KEY]: JSON.stringify([CUSTOM, { id: "broken" }, "nonsense", { ...CUSTOM, id: "" }]) }),
  );
  expect(loadCustomProfiles()).toEqual([CUSTOM]);

  restore();
  restore = withStorage(memoryStorage({ [KEY]: "{not json" }));
  expect(loadCustomProfiles()).toEqual([]);
});

test("only the user's own profiles are persisted", () => {
  const untouched = [...BUNDLED_PROFILES];
  expect(customOnly(untouched)).toEqual([]);
  expect(customOnly([...untouched, CUSTOM])).toEqual([CUSTOM]);
  // An edited bundled profile IS the user's own now.
  const edited = { ...BUNDLED_PROFILES[0]!, cores: 12 };
  expect(customOnly([edited])).toEqual([edited]);
});

test("profile lookup and id derivation", () => {
  expect(profileById(NO_PROFILE_ID, [CUSTOM])).toBeNull();
  expect(profileById("nope", [CUSTOM])).toBeNull();
  expect(profileById("hpc", [CUSTOM])).toEqual(CUSTOM);
  expect(profileIdFromName("  HPC Fat Node (v2) ")).toBe("hpc-fat-node-v2");
});

test("the walltime cap is checked — it appears nowhere in the input text", () => {
  expect(profileProblems(null, 999)).toEqual([]);
  expect(profileProblems(CUSTOM, 24)).toEqual([]);
  const over = profileProblems(CUSTOM, 72);
  expect(over[0]).toContain("exceeds the 48 h cap");
  // A profile with no cap never complains.
  expect(profileProblems({ ...CUSTOM, walltimeCapHours: 0 }, 999)).toEqual([]);
});
