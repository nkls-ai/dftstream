import { useState } from "react";
import {
  useDataSource,
  type AddMemberCandidate,
  type OrgRole,
} from "../data/DataSource";
import { useGuardedAction } from "../hooks/useGuardedAction";
import { formatTimeAgo } from "../lib/time";
import { assignableRoles } from "../lib/orgRoles";

// What the last add attempt came back with, when it did not grant outright.
//
//   invited — no account exists for the email; the backend recorded a pending
//             invite and granted NOTHING. The admin re-adds once the person
//             has signed in.
//   confirm — an account exists but its email is self-asserted (never
//             verified), so the backend refuses to grant on the match alone.
//             It returned what it knows about the account; the admin verifies
//             out-of-band and explicitly confirms, which re-calls addMember
//             bound to the reviewed account id.
type PendingOutcome =
  | { kind: "invited"; email: string }
  | { kind: "confirm"; email: string; role: OrgRole; candidate: AddMemberCandidate };

/** "Add member" email + role form, shown to org admins. */
export function OrgInviteRow({
  orgId,
  isOwner,
}: {
  orgId: string;
  isOwner: boolean;
}) {
  const ds = useDataSource();
  const guard = useGuardedAction();
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<OrgRole>("member");
  const [outcome, setOutcome] = useState<PendingOutcome | null>(null);

  const submit = () =>
    void guard("add member", async () => {
      const email = inviteEmail.trim();
      const res = await ds.addOrgMember(orgId, email, inviteRole);
      if (res.status === "added") {
        setInviteEmail("");
        setOutcome(null);
      } else if (res.status === "invited") {
        setInviteEmail("");
        setOutcome({ kind: "invited", email });
      } else {
        setOutcome({
          kind: "confirm",
          email,
          role: inviteRole,
          candidate: res.candidate,
        });
      }
    });

  const confirm = (o: Extract<PendingOutcome, { kind: "confirm" }>) =>
    void guard("confirm member", async () => {
      const res = await ds.addOrgMember(orgId, o.email, o.role, o.candidate.userId);
      if (res.status === "added") {
        setInviteEmail("");
        setOutcome(null);
      }
      // Any other status here means the account changed between review and
      // confirm; the backend throws for that, which guard() surfaces.
    });

  return (
    <div className="settings-row">
      <div className="settings-row-label">Add member</div>
      <div className="org-invite">
        <input aria-label="Member email"
          type="email"
          placeholder="email@lab.edu"
          value={inviteEmail}
          onChange={(e) => setInviteEmail(e.target.value)}
        />
        <select
          aria-label="New member role"
          value={inviteRole}
          onChange={(e) => setInviteRole(e.target.value as OrgRole)}
        >
          {assignableRoles(isOwner).map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <button
          className="button"
          type="button"
          disabled={!inviteEmail.trim()}
          onClick={submit}
        >
          Add
        </button>
      </div>
      {outcome?.kind === "invited" && (
        <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
          No account exists for {outcome.email} yet. The invite is recorded;
          nothing has been granted. Add them again once they have signed in.
        </div>
      )}
      {outcome?.kind === "confirm" && (
        <div className="org-invite-confirm" style={{ fontSize: 13, marginTop: 6 }}>
          <div>
            An account matches {outcome.email}, but the address was never
            verified. Check with the person before granting.
          </div>
          <div className="muted" style={{ marginTop: 4 }}>
            Account created {formatTimeAgo(outcome.candidate.accountCreatedAt)}
            {outcome.candidate.name ? ` · name: ${outcome.candidate.name}` : ""}
            {" · last active "}
            {outcome.candidate.lastSeenAt != null
              ? formatTimeAgo(outcome.candidate.lastSeenAt)
              : "never"}
          </div>
          {outcome.candidate.invitePendingSince != null &&
            outcome.candidate.accountCreatedAt >
              outcome.candidate.invitePendingSince && (
              <div style={{ marginTop: 4 }}>
                This account was created after the invite was sent.
              </div>
            )}
          <div style={{ marginTop: 6, display: "flex", gap: 8 }}>
            <button className="button" type="button" onClick={() => confirm(outcome)}>
              Grant {outcome.role} to this account
            </button>
            <button className="button" type="button" onClick={() => setOutcome(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
