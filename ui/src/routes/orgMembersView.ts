// Pure view logic for the org member list: display ordering and text
// filtering. React-free so it can be unit tested.

import type { OrgMember } from "../data/DataSource";
import { rank } from "../lib/orgRoles";

type MemberIdentity = Pick<OrgMember, "email" | "name" | "appUserId">;

/** The label the member list displays — email first, then name, then id. */
export function memberLabel(m: MemberIdentity): string {
  return m.email ?? m.name ?? m.appUserId;
}

/**
 * Case-insensitive substring match on email or name. A blank query returns
 * the input array unchanged.
 */
export function filterMembers<T extends MemberIdentity>(members: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return members;
  return members.filter(
    (m) =>
      (m.email ?? "").toLowerCase().includes(q) ||
      (m.name ?? "").toLowerCase().includes(q),
  );
}

/**
 * Sorted copy: role privilege first (owner, admin, member, viewer — rank from
 * lib/orgRoles), then the displayed label A-Z. Never mutates the input.
 */
export function sortMembers<T extends MemberIdentity & Pick<OrgMember, "role">>(members: T[]): T[] {
  return members
    .slice()
    .sort((a, b) => rank(b.role) - rank(a.role) || memberLabel(a).localeCompare(memberLabel(b)));
}
