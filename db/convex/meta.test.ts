/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { API_VERSION, FEATURES, MIN_WRAPPER_API_VERSION } from "./meta";

const modules = import.meta.glob("./**/*.ts");

describe("meta.version handshake", () => {
  test("reports the API version without authentication", async () => {
    const t = convexTest(schema, modules);
    // No withIdentity(): the wrapper calls this before proving its token.
    const v = await t.query(api.meta.version, {});
    expect(v.apiVersion).toBe(API_VERSION);
    expect(v.minWrapperApiVersion).toBe(MIN_WRAPPER_API_VERSION);
  });

  test("support window is exactly N and N-1", () => {
    expect(MIN_WRAPPER_API_VERSION).toBe(API_VERSION - 1);
  });

  test("advertises capabilities the wrapper probes for", async () => {
    const t = convexTest(schema, modules);
    const v = await t.query(api.meta.version, {});
    // Names are additive-only; removing one is a breaking change that must
    // bump API_VERSION, so pin the current set.
    expect(v.features).toEqual([...FEATURES]);
    expect(v.features).toContain("propertyJson");
  });
});
