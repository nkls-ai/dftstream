import { useMemo, useState } from "react";
import { useDataSource, type OrgMember, type OrgRole } from "../data/DataSource";
import { useConfirm } from "../components/Confirm";
import { useGuardedAction } from "../hooks/useGuardedAction";
import { assignableRoles, canEditMemberRole, canRemoveMember, isSelfDemotion } from "../lib/orgRoles";
import { filterMembers, sortMembers } from "./orgMembersView";

/** Org member list with role editing and removal for admins/owners. */
export function OrgMembersList({
  members,
  isAdmin,
  isOwner,
  selfUserId,
}: {
  members: OrgMember[];
  isAdmin: boolean;
  isOwner: boolean;
  /** The signed-in user's appUsers id, to confirm self-demotion. */
  selfUserId?: string;
}) {
  const ds = useDataSource();
  const confirm = useConfirm();
  const guard = useGuardedAction();
  const [query, setQuery] = useState("");

  const sorted = useMemo(() => sortMembers(members), [members]);
  const visible = useMemo(() => filterMembers(sorted, query), [sorted, query]);
  const filtering = query.trim() !== "";

  return (
    <div className="settings-row org-members">
      <div className="settings-row-label">Members</div>
      {members.length > 8 && (
        <div className="table-toolbar">
          <input
            type="search"
            placeholder="Filter members…"
            aria-label="Filter members by email or name"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {filtering && (
            <span className="table-toolbar-count">
              {visible.length} of {members.length} members
            </span>
          )}
        </div>
      )}
      {filtering && visible.length === 0 && (
        <div className="muted" style={{ fontSize: 13 }}>No members match.</div>
      )}
      <ul className="org-member-list">
        {visible.map((m) => (
          <li key={m.membershipId}>
            <span className="org-member-email">{m.email ?? m.name ?? m.appUserId}</span>
            {isAdmin && canEditMemberRole(isOwner, m.role) ? (
              <select
                aria-label={`Role for ${m.email ?? m.name ?? m.appUserId}`}
                value={m.role}
                onChange={(e) => {
                  const next = e.target.value as OrgRole;
                  void guard("change role", async () => {
                    if (
                      isSelfDemotion(selfUserId, m, next) &&
                      !(await confirm({
                        title: "Lower your own role?",
                        message: `You will become ${next} in this organization and cannot undo this yourself.`,
                        tone: "danger",
                      }))
                    ) {
                      return;
                    }
                    await ds.updateOrgMemberRole(m.membershipId, next);
                  });
                }}
              >
                {assignableRoles(isOwner).map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            ) : (
              <span className="org-member-role muted">{m.role}</span>
            )}
            {isAdmin && canRemoveMember(isOwner, m.role) && (
              <button
                type="button"
                className="org-member-remove"
                title="Remove"
                onClick={() =>
                  void guard("remove member", async () => {
                    if (
                      await confirm({
                        title: "Remove member?",
                        message: `Remove ${m.email ?? m.appUserId} from this organization?`,
                      })
                    ) {
                      await ds.removeOrgMember(m.membershipId);
                    }
                  })
                }
              >
                ✕
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
