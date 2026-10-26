import { describe, expect, test } from "bun:test";
import {
  ROLES,
  assignableRoles,
  canEditMemberRole,
  canRemoveMember,
  isSelfDemotion,
  rank,
} from "./orgRoles";

describe("canRemoveMember", () => {
  test("admins cannot remove owners (backend refuses it)", () => {
    expect(canRemoveMember(false, "owner")).toBe(false);
    expect(canRemoveMember(false, "admin")).toBe(true);
  });
  test("owners can remove anyone", () => {
    expect(canRemoveMember(true, "owner")).toBe(true);
  });
});

describe("isSelfDemotion", () => {
  const me = { appUserId: "u1", role: "admin" as const };
  test("lowering your own role is a self-demotion", () => {
    expect(isSelfDemotion("u1", me, "member")).toBe(true);
  });
  test("raising, keeping, or changing someone else is not", () => {
    expect(isSelfDemotion("u1", me, "admin")).toBe(false);
    expect(isSelfDemotion("u1", me, "owner")).toBe(false);
    expect(isSelfDemotion("u2", me, "viewer")).toBe(false);
    expect(isSelfDemotion(undefined, me, "viewer")).toBe(false);
  });
});

describe("rank", () => {
  test("orders owner > admin > member > viewer", () => {
    expect(rank("owner")).toBeGreaterThan(rank("admin"));
    expect(rank("admin")).toBeGreaterThan(rank("member"));
    expect(rank("member")).toBeGreaterThan(rank("viewer"));
  });
});

describe("assignableRoles", () => {
  test("non-owners cannot assign owner", () => {
    expect(assignableRoles(false)).toEqual(["admin", "member", "viewer"]);
  });
  test("owners can assign every role", () => {
    expect(assignableRoles(true)).toEqual(ROLES);
  });
});

describe("canEditMemberRole", () => {
  test("admins cannot edit owners", () => {
    expect(canEditMemberRole(false, "owner")).toBe(false);
  });
  test("admins can edit admins and below", () => {
    expect(canEditMemberRole(false, "admin")).toBe(true);
    expect(canEditMemberRole(false, "member")).toBe(true);
    expect(canEditMemberRole(false, "viewer")).toBe(true);
  });
  test("owners can edit everyone", () => {
    for (const r of ROLES) expect(canEditMemberRole(true, r)).toBe(true);
  });
});
