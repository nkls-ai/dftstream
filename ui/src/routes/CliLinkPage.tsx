import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useDataSource } from "../data/DataSource";
import { useOrg } from "../auth/OrgContext";
import { userErrorMessage } from "../lib/errorReporting";
import { normalizeUserCode } from "../lib/userCode";

// Approval screen for `dftstream login` (browser-link). The CLI prints a
// short USER code and opens /cli-link?userCode=…; the signed-in user picks
// which org the CLI should act in and approves. The CLI then polls the backend
// with its separate secret device code and receives a token — the value in
// this URL can target an approval but can never yield tokens itself.
export function CliLinkPage() {
  const ds = useDataSource();
  const { orgs, loading } = useOrg();
  const [params] = useSearchParams();
  const [code, setCode] = useState(() => params.get("userCode") ?? "");
  const [orgId, setOrgId] = useState(orgs[0]?.organizationId ?? "");
  const [approvedOrg, setApprovedOrg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Memberships load after mount, so orgs is empty on first render and orgId
  // initializes to "" (Approve stays disabled). Default to the first org once
  // they resolve. The <select> shows org[0] by default but state must match.
  useEffect(() => {
    if (!orgId && orgs.length > 0) setOrgId(orgs[0]!.organizationId);
  }, [orgs, orgId]);

  // The code the backend will match: typed lowercase / without the dash still works.
  const normalized = normalizeUserCode(code);
  const selected = orgs.find((o) => o.organizationId === orgId);

  async function approve() {
    if (!selected) return;
    setError(null);
    setBusy(true);
    try {
      await ds.approveCliLink(normalized, selected.organizationId);
      setApprovedOrg(selected.name);
    } catch (err) {
      setError(userErrorMessage(err, "approve the CLI link"));
    } finally {
      setBusy(false);
    }
  }

  if (approvedOrg !== null) {
    return (
      <div className="empty-state">
        <h2>CLI connected ✓</h2>
        <p>
          The CLI now acts in <strong>{approvedOrg}</strong>. You can return to
          your terminal - the login will complete shortly.
        </p>
      </div>
    );
  }

  if (!loading && orgs.length === 0) {
    return (
      <div className="cli-link-panel">
        <h2>Connect CLI</h2>
        <p>
          You are not in any organization yet, and the CLI always acts inside
          one. Create an organization from the sidebar (or ask an admin to add
          you), then open this link again.
        </p>
      </div>
    );
  }

  return (
    <div className="cli-link-panel">
      <h2>Connect CLI</h2>
      <p>Approve the DFTStream CLI to act in an organization on your behalf.</p>
      <label>
        Code
        <input value={code} onChange={(e) => setCode(e.target.value)} />
      </label>
      <label>
        Organization
        <select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
          {orgs.map((o) => (
            <option key={o.organizationId} value={o.organizationId}>
              {o.name} · {o.role}
            </option>
          ))}
        </select>
      </label>
      {error && <div className="login-error">{error}</div>}
      <button
        className="button"
        type="button"
        onClick={() => void approve()}
        disabled={busy || normalized === "" || !selected}
      >
        Approve
      </button>
    </div>
  );
}
