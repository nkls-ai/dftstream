import { useDataSource } from "../data/DataSource";
import { useOrg } from "../auth/OrgContext";
import { useConfirm } from "../components/Confirm";
import { useGuardedAction } from "../hooks/useGuardedAction";
import { absoluteTimeTitle, formatTimeAgo } from "../lib/time";
import { expiresLabel, lastUsedLabel, sessionOrgLabel, sortCliSessions } from "./tokenSettingsView";

/**
 * The current user's live browser-linked CLI sessions (`dftstream login`),
 * with revoke. Revocation kills the session's refresh chain immediately; the
 * outstanding access token dies within the hour.
 */
export function CliSessionsList() {
  const ds = useDataSource();
  const { orgs } = useOrg();
  const confirm = useConfirm();
  const guard = useGuardedAction();
  const sessions = ds.useMyCliSessions();

  const rows = sortCliSessions(sessions.data ?? []);
  const now = Date.now();

  return (
    <div className="settings-row org-members">
      <div className="settings-row-label">CLI sessions</div>
      {!sessions.loading && rows.length === 0 && (
        <div className="muted" style={{ fontSize: 13 }}>
          No CLI sessions. Run <code>dftstream login</code> to connect one.
        </div>
      )}
      <ul className="org-member-list">
        {rows.map((s) => (
          <li key={s.linkId}>
            <span className="org-member-email">{sessionOrgLabel(s.organizationId, orgs)}</span>
            <span className="muted" title={absoluteTimeTitle(s.createdAt, "locale")}>
              linked {formatTimeAgo(s.createdAt, now)}
            </span>
            <span
              className="muted"
              title={s.lastUsedAt !== null ? absoluteTimeTitle(s.lastUsedAt, "locale") : undefined}
            >
              {lastUsedLabel(s.lastUsedAt, now)}
            </span>
            {s.expiresAt !== null && (
              <span className="muted" title={absoluteTimeTitle(s.expiresAt, "locale")}>
                {expiresLabel(s.expiresAt, now)}
              </span>
            )}
            <button
              type="button"
              className="org-member-remove"
              title="Revoke session"
              onClick={() =>
                void guard("revoke CLI session", async () => {
                  if (
                    await confirm({
                      title: "Revoke CLI session?",
                      message:
                        "The CLI using this session will need `dftstream login` again within the hour.",
                    })
                  ) {
                    await ds.revokeCliSession(s.linkId);
                  }
                })
              }
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
