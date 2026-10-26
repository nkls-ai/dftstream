import { describe, expect, test } from "bun:test";
import type { ConvexReactClient } from "convex/react";
import { ConvexDataSource } from "../data/ConvexDataSource";
import { startupMigrationsReady } from "./startupMigrations";
import type { OrgMembership } from "../data/DataSource";

const ORG = { organizationId: "o1", name: "Lab", slug: "lab", role: "member" } as OrgMembership;

describe("startup migration kicks", () => {
  test("constructing the data source sends nothing", () => {
    // Regression: the kicks ran in the constructor, before any sign-in, so an
    // auth-enabled deployment answered "not authenticated" on every load.
    const calls: unknown[] = [];
    const client = { mutation: (...a: unknown[]) => { calls.push(a); return Promise.resolve(null); } };
    const ds = new ConvexDataSource(client as unknown as ConvexReactClient);
    expect(calls).toHaveLength(0);
    ds.kickStartupMigrations();
    expect(calls).toHaveLength(3);
    ds.kickStartupMigrations();
    expect(calls).toHaveLength(3);
  });

  test("auth off: kick immediately", () => {
    expect(startupMigrationsReady({ authEnabled: false, loading: true, orgs: [] })).toBe(true);
  });

  test("auth on: only once the user is known to belong to an org", () => {
    expect(startupMigrationsReady({ authEnabled: true, loading: true, orgs: [] })).toBe(false);
    expect(startupMigrationsReady({ authEnabled: true, loading: false, orgs: [] })).toBe(false);
    expect(startupMigrationsReady({ authEnabled: true, loading: false, orgs: [ORG] })).toBe(true);
  });
});
