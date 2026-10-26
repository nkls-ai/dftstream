import { useState } from "react";
import { useDataSource } from "../data/DataSource";
import { useConfirm } from "../components/Confirm";
import { useGuardedAction } from "../hooks/useGuardedAction";
import { reportError } from "../lib/errorReporting";
import { absoluteTimeTitle, formatTimeAgo } from "../lib/time";
import { lastUsedLabel, sortMachineTokens } from "./tokenSettingsView";

/**
 * Machine tokens (admin-only): org-scoped credentials for non-interactive
 * auth — a batch/SLURM job sets DFTSTREAM_TOKEN instead of running
 * `dftstream login`. The secret is shown exactly once at creation; the list
 * shows created/last-used so a leaked or stale token can be found and revoked.
 */
export function OrgMachineTokens({ orgId }: { orgId: string }) {
  const ds = useDataSource();
  const confirm = useConfirm();
  const guard = useGuardedAction();
  const tokens = ds.useMachineTokens(orgId);

  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  // The one-time secret reveal. Cleared only by the explicit Done button —
  // once dismissed it is gone for good, so dismissal must be deliberate.
  const [minted, setMinted] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const rows = sortMachineTokens(tokens.data ?? []);
  const now = Date.now();

  const create = () =>
    void guard("create machine token", async () => {
      const label = name.trim();
      if (label === "") return;
      setCreating(true);
      try {
        const res = await ds.createMachineToken(orgId, label);
        setMinted({ name: res.name, token: res.token });
        setCopied(false);
        setName("");
      } finally {
        setCreating(false);
      }
    });

  const copySecret = async () => {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted.token);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      // Clipboard can be blocked (permissions, insecure context); the secret
      // stays on screen for manual selection, so log rather than alert.
      reportError(err, { source: "org-machine-tokens", action: "copy machine token" });
    }
  };

  return (
    <div className="settings-row org-members">
      <div className="settings-row-label">Machine tokens</div>
      <div className="settings-row-desc">
        For batch and SLURM jobs that cannot open a browser: set the token as{" "}
        <code>DFTSTREAM_TOKEN</code> in the job environment. Tokens act in
        this organization only and can be revoked here at any time.
      </div>

      {minted && (
        <div className="settings-row-desc" role="alert">
          <div>
            Token <strong>{minted.name}</strong> created. Copy it now —{" "}
            <strong>it will not be shown again.</strong>
          </div>
          <code style={{ userSelect: "all", wordBreak: "break-all", display: "block", margin: "6px 0" }}>
            {minted.token}
          </code>
          <button className="button" type="button" onClick={() => void copySecret()}>
            {copied ? "Copied" : "Copy token"}
          </button>{" "}
          <button className="button" type="button" onClick={() => setMinted(null)}>
            Done
          </button>
        </div>
      )}

      <form
        className="table-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <input
          type="text"
          placeholder="Token name (e.g. cluster-A batch)"
          aria-label="New machine token name"
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
        />
        <button className="button" type="submit" disabled={creating || name.trim() === ""}>
          Create token
        </button>
      </form>

      {!tokens.loading && rows.length === 0 && (
        <div className="muted" style={{ fontSize: 13 }}>No machine tokens.</div>
      )}
      <ul className="org-member-list">
        {rows.map((t) => (
          <li key={t.tokenId}>
            <span className="org-member-email">{t.name}</span>
            <span className="muted" title={absoluteTimeTitle(t.createdAt, "locale")}>
              created {formatTimeAgo(t.createdAt, now)}
            </span>
            <span
              className="muted"
              title={t.lastUsedAt !== null ? absoluteTimeTitle(t.lastUsedAt, "locale") : undefined}
            >
              {lastUsedLabel(t.lastUsedAt, now)}
            </span>
            {t.revokedAt !== null ? (
              <span className="org-member-role muted">revoked</span>
            ) : (
              <button
                type="button"
                className="org-member-remove"
                title="Revoke"
                onClick={() =>
                  void guard("revoke machine token", async () => {
                    if (
                      await confirm({
                        title: "Revoke machine token?",
                        message: `Jobs using "${t.name}" will fail to authenticate within the hour. This cannot be undone.`,
                        tone: "danger",
                      })
                    ) {
                      await ds.revokeMachineToken(t.tokenId);
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
