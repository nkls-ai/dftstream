import type { OrgRole } from "../data/DataSource";

/** All roles, highest privilege first. */
export const ROLES: OrgRole[] = ["owner", "admin", "member", "viewer"];

/** Numeric privilege rank — owner highest. */
export function rank(r: OrgRole): number {
  return ROLES.length - ROLES.indexOf(r);
}

/** Roles the current actor may assign: only owners can hand out "owner". */
export function assignableRoles(isOwner: boolean): OrgRole[] {
  return ROLES.filter((r) => r !== "owner" || isOwner);
}

/**
 * Whether an admin-or-owner actor may change a member with `targetRole`:
 * owners can edit anyone, admins only non-owners.
 */
export function canEditMemberRole(isOwner: boolean, targetRole: OrgRole): boolean {
  return isOwner || rank(targetRole) <= rank("admin");
}

/**
 * Whether an admin-or-owner actor may remove a member with `targetRole`.
 * Same rule the backend enforces in organizations.removeMember: removing an
 * owner is owner-only (an admin must not escalate by deleting co-owners).
 */
export function canRemoveMember(isOwner: boolean, targetRole: OrgRole): boolean {
  return canEditMemberRole(isOwner, targetRole);
}

/** True when `nextRole` lowers the actor's OWN role — worth a confirmation,
 *  since they cannot undo it themselves afterwards. */
export function isSelfDemotion(
  selfUserId: string | undefined,
  member: { appUserId: string; role: OrgRole },
  nextRole: OrgRole,
): boolean {
  return (
    selfUserId !== undefined &&
    member.appUserId === selfUserId &&
    rank(nextRole) < rank(member.role)
  );
}
