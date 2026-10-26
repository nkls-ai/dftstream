import { useDataSource } from "../data/DataSource";
import { orgQueryArg, useOrg } from "../auth/OrgContext";
import { useAuthSession } from "../auth/AuthSession";
import { useConfirm } from "../components/Confirm";
import { useGuardedAction } from "../hooks/useGuardedAction";
import { OrgInviteRow } from "./OrgInviteRow";
import { OrgMembersList } from "./OrgMembersList";
import { OrgMachineTokens } from "./OrgMachineTokens";
import { CliSessionsList } from "./CliSessionsList";
import { orgSectionKeys } from "./orgSectionKeys";

// Account + organization management, shown in Settings when auth is enabled.
export function OrgSettings() {
  const org = useOrg();
  const ds = useDataSource();
  const me = ds.useMe();
  const { signOut } = useAuthSession();
  const confirm = useConfirm();
  const guard = useGuardedAction();

  const activeId = org.activeOrgId;
  // Gate on a confirmed membership (orgQueryArg), not the raw active id — a
  // stale localStorage org from a prior user would otherwise throw "not a
  // member" here too.
  const membersArg = orgQueryArg(org);
  const members = ds.useOrgMembers(membersArg === undefined ? "skip" : membersArg);
  const isAdmin = org.role === "admin" || org.role === "owner";
  const isOwner = org.role === "owner";
  const keys = orgSectionKeys(activeId);

  if (!org.authEnabled) return null;

  return (
    <>
      <section className="settings-section">
        <h2 className="settings-section-title">Account</h2>
        <div className="settings-rows">
          <div className="settings-row">
            <div className="settings-row-label">Signed in as</div>
            <div className="settings-row-value">{me.data?.email ?? me.data?.name ?? "—"}</div>
          </div>
          <div className="settings-row">
            <div className="settings-row-label">Session</div>
            <button
              className="button"
              type="button"
              onClick={() => void guard("sign out", signOut)}
            >
              Sign out
            </button>
          </div>
          <CliSessionsList />
        </div>
      </section>

      <section className="settings-section">
        <h2 className="settings-section-title">Organization</h2>
        {!activeId || !org.activeOrg ? (
          <div className="settings-row-desc">
            No organization selected. Create or pick one from the sidebar.
          </div>
        ) : (
          <div className="settings-rows">
            <div className="settings-row">
              <div className="settings-row-label">Name</div>
              <div className="settings-row-value">
                {org.activeOrg?.name} <span className="muted">· you are {org.role}</span>
              </div>
            </div>

            {/* Keyed by org: a reviewed invite candidate or a one-time token
                reveal must never carry over into another org after a switch
                (confirming would otherwise grant in the NEW org). */}
            {isAdmin && <OrgInviteRow key={keys.invite} orgId={activeId} isOwner={isOwner} />}

            <OrgMembersList
              members={members.data ?? []}
              isAdmin={isAdmin}
              isOwner={isOwner}
              selfUserId={me.data?.id}
            />

            {/* machineTokens.list is admin-gated server-side; only mount the
                query for admins so viewers don't hit a "insufficient
                permission" error on the settings page. */}
            {isAdmin && <OrgMachineTokens key={keys.machineTokens} orgId={activeId} />}

            {isOwner && (
              <div className="settings-row">
                <div className="settings-row-label">Danger zone</div>
                <button
                  className="button button-danger"
                  type="button"
                  onClick={() =>
                    void guard("delete organization", async () => {
                      if (
                        await confirm({
                          title: "Delete organization?",
                          message: "This only works once all experiments are deleted.",
                          tone: "danger",
                        })
                      ) {
                        await ds.removeOrg(activeId);
                      }
                    })
                  }
                >
                  Delete organization
                </button>
              </div>
            )}
          </div>
        )}
      </section>
    </>
  );
}
