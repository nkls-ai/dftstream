import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useDataSource } from "../data/DataSource";
import type { OrgMembership, OrgRole } from "../data/DataSource";
import { STORAGE_KEYS } from "../lib/storageKeys";

const ACTIVE_ORG_KEY = STORAGE_KEYS.activeOrg;

function readActiveOrg(): string | undefined {
  try {
    return localStorage.getItem(ACTIVE_ORG_KEY) ?? undefined;
  } catch {
    /* private browsing / disabled storage — fall back to no selection */
    return undefined;
  }
}

function writeActiveOrg(id: string | undefined): void {
  try {
    if (id) localStorage.setItem(ACTIVE_ORG_KEY, id);
    else localStorage.removeItem(ACTIVE_ORG_KEY);
  } catch {
    /* best-effort persistence; selection still lives in memory this session */
  }
}

export interface OrgContextValue {
  authEnabled: boolean;
  orgs: OrgMembership[];
  loading: boolean;
  activeOrgId?: string;
  activeOrg?: OrgMembership;
  role?: OrgRole;
  setActiveOrg(id: string): void;
}

const OrgContext = createContext<OrgContextValue | null>(null);

export function OrgProvider({
  authEnabled,
  children,
}: {
  authEnabled: boolean;
  children: ReactNode;
}) {
  const ds = useDataSource();
  const orgsResult = ds.useMyOrgs();
  const [activeOrgId, setActiveOrgId] = useState<string | undefined>(readActiveOrg);

  // Provision the caller's identity row once authenticated, so admins can add
  // them to orgs by email. Best-effort: a failure just delays that.
  useEffect(() => {
    if (!authEnabled) return;
    ds.ensureSelf().catch((err) => {
      console.error("ensureSelf failed", err);
    });
  }, [authEnabled, ds]);

  const orgs = useMemo(() => orgsResult.data ?? [], [orgsResult.data]);

  // Keep the active selection valid: default to the first org, and clear a
  // stale id that's no longer a membership.
  useEffect(() => {
    if (!authEnabled || orgsResult.loading) return;
    const stillMember = activeOrgId && orgs.some((o) => o.organizationId === activeOrgId);
    if (!stillMember) {
      const next = orgs[0]?.organizationId;
      setActiveOrgId(next);
      writeActiveOrg(next);
    }
  }, [authEnabled, orgsResult.loading, orgs, activeOrgId]);

  const value = useMemo<OrgContextValue>(() => {
    const activeOrg = orgs.find((o) => o.organizationId === activeOrgId);
    return {
      authEnabled,
      orgs,
      loading: orgsResult.loading,
      activeOrgId,
      activeOrg,
      role: activeOrg?.role,
      setActiveOrg: (id: string) => {
        setActiveOrgId(id);
        writeActiveOrg(id);
      },
    };
  }, [authEnabled, orgs, orgsResult.loading, activeOrgId]);

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}

export function useOrg(): OrgContextValue {
  const v = useContext(OrgContext);
  if (!v) {
    // Auth disabled: no provider mounted. Report a permissive default so
    // components can call useOrg() unconditionally.
    return {
      authEnabled: false,
      orgs: [],
      loading: false,
      setActiveOrg: () => {},
    };
  }
  return v;
}

// The organizationId argument to pass to org-scoped list queries: undefined
// when auth is off (backend ignores it), "skip" when auth is on but no usable
// org is selected, else the active org id.
//
// Crucially we only ever return an id we've CONFIRMED is a live membership
// (ctx.activeOrg resolves). While the membership list is still loading, or the
// active id is stale — e.g. a just-signed-out user's org left in localStorage
// when a different user signs up — we suspend instead of firing a query that
// would throw "not a member" and trip the fatal error boundary.
export function orgQueryArg(
  ctx: Pick<OrgContextValue, "authEnabled" | "activeOrgId" | "activeOrg" | "loading">,
): string | "skip" | undefined {
  if (!ctx.authEnabled) return undefined;
  if (ctx.loading || !ctx.activeOrg) return "skip";
  return ctx.activeOrgId;
}
