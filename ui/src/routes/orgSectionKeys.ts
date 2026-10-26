/**
 * React keys for the org-settings sections that hold one-shot state (a
 * reviewed invite candidate, a machine-token reveal). Keyed by org so a
 * switch remounts them and that state can never carry into another org —
 * and distinct per section, because they are siblings: both used to be
 * keyed by the bare org id, a duplicate key React warns about and whose
 * reconciliation (the very remount this relies on) it does not guarantee.
 */
export function orgSectionKeys(orgId: string | undefined): { invite: string; machineTokens: string } {
  const org = orgId ?? "none";
  return { invite: `invite:${org}`, machineTokens: `machine-tokens:${org}` };
}
