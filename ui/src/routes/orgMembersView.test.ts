import { describe, expect, test } from "bun:test";
import type { OrgMember, OrgRole } from "../data/DataSource";
import { filterMembers, memberLabel, sortMembers } from "./orgMembersView";

let seq = 0;
function mk(role: OrgRole, email: string | null, name: string | null = null): OrgMember {
  seq += 1;
  return { membershipId: `m${seq}`, appUserId: `u${seq}`, email, name, role };
}

describe("memberLabel", () => {
  test("prefers email, then name, then appUserId", () => {
    expect(memberLabel({ email: "a@x.org", name: "Ada", appUserId: "u1" })).toBe("a@x.org");
    expect(memberLabel({ email: null, name: "Ada", appUserId: "u1" })).toBe("Ada");
    expect(memberLabel({ email: null, name: null, appUserId: "u1" })).toBe("u1");
  });
});

describe("filterMembers", () => {
  const members = [
    mk("member", "ada@lab.org", "Ada Lovelace"),
    mk("member", "grace@lab.org", "Grace Hopper"),
    mk("member", null, "Niels Bohr"),
    mk("member", null, null),
  ];

  test("blank query returns the input unchanged", () => {
    expect(filterMembers(members, "")).toBe(members);
    expect(filterMembers(members, "  ")).toBe(members);
  });

  test("matches email or name case-insensitively", () => {
    expect(filterMembers(members, "ADA").map(memberLabel)).toEqual(["ada@lab.org"]);
    expect(filterMembers(members, "bohr").map(memberLabel)).toEqual(["Niels Bohr"]);
    expect(filterMembers(members, "lab.org")).toHaveLength(2);
  });

  test("members with neither email nor name never match a non-empty query", () => {
    expect(filterMembers(members, "u")).toEqual([]);
  });
});

describe("sortMembers", () => {
  test("orders by role privilege then display label", () => {
    const members = [
      mk("viewer", "zoe@lab.org"),
      mk("member", "bob@lab.org"),
      mk("owner", "olga@lab.org"),
      mk("admin", "amy@lab.org"),
      mk("member", "alf@lab.org"),
    ];
    expect(sortMembers(members).map(memberLabel)).toEqual([
      "olga@lab.org",
      "amy@lab.org",
      "alf@lab.org",
      "bob@lab.org",
      "zoe@lab.org",
    ]);
  });

  test("does not mutate the input array", () => {
    const members = [mk("viewer", "b@x.org"), mk("owner", "a@x.org")];
    const copy = members.slice();
    sortMembers(members);
    expect(members).toEqual(copy);
  });
});
