// Pure view logic for the machine-token and CLI-session settings sections:
// display ordering and status/last-used labels. React-free so it can be unit
// tested (see tokenSettingsView.test.ts).

import type { CliSessionInfo, MachineTokenInfo, OrgMembership } from "../data/DataSource";
import { formatTimeAgo } from "../lib/time";

/**
 * Sorted copy for the machine-token list: active tokens first (newest
 * created on top), revoked ones after (kept visible as an audit trail).
 * Never mutates the input.
 */
export function sortMachineTokens(tokens: MachineTokenInfo[]): MachineTokenInfo[] {
  return tokens
    .slice()
    .sort(
      (a, b) =>
        Number(a.revokedAt !== null) - Number(b.revokedAt !== null) ||
        b.createdAt - a.createdAt,
    );
}

/**
 * The "last used" column. `null` means the token/session has never minted an
 * access token — for a machine token that distinguishes "parked in a batch
 * profile" from "actively exchanged", which is exactly what an admin deciding
 * whether to revoke needs to know.
 */
export function lastUsedLabel(lastUsedAt: number | null, now: number = Date.now()): string {
  return lastUsedAt === null ? "never used" : `used ${formatTimeAgo(lastUsedAt, now)}`;
}

/**
 * The org label for a CLI session row: the org's name when the caller still
 * belongs to it, a shortened id when not (a session bound to an org the user
 * has since left is still theirs to revoke), or a dash for pre-org-scoping
 * legacy sessions.
 */
export function sessionOrgLabel(
  organizationId: string | null,
  orgs: Pick<OrgMembership, "organizationId" | "name">[],
): string {
  if (organizationId === null) return "—";
  const match = orgs.find((o) => o.organizationId === organizationId);
  if (match) return match.name;
  return organizationId.length > 8 ? `${organizationId.slice(0, 8)}…` : organizationId;
}

/**
 * The "expires" column for a CLI session (refreshExpiresAt is in the FUTURE,
 * so formatTimeAgo cannot render it). Whole days above 48 h, hours below —
 * the reader is deciding "do I need to re-login before my next batch run",
 * not scheduling to the minute.
 */
export function expiresLabel(expiresAt: number, now: number = Date.now()): string {
  const ms = expiresAt - now;
  if (ms <= 0) return "expired";
  const hours = Math.ceil(ms / (60 * 60 * 1000));
  if (hours >= 48) return `expires in ${Math.round(hours / 24)}d`;
  return `expires in ${hours}h`;
}

/** Sessions newest-first — the one just approved is the one being looked for. */
export function sortCliSessions(sessions: CliSessionInfo[]): CliSessionInfo[] {
  return sessions.slice().sort((a, b) => b.createdAt - a.createdAt);
}
