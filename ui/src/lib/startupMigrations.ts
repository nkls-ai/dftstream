import { useEffect } from "react";
import { useDataSource } from "../data/DataSource";
import { useOrg, type OrgContextValue } from "../auth/OrgContext";

/**
 * Whether the one-shot backfill migrations may be kicked now. With auth off
 * anyone may (the backend gate is a no-op). With auth on the backend requires
 * membership in some org, so wait until the signed-in user's orgs are known
 * and non-empty — kicking earlier only earns a "not authenticated" /
 * "not a member" error on every page load.
 */
export function startupMigrationsReady(
  org: Pick<OrgContextValue, "authEnabled" | "loading" | "orgs">,
): boolean {
  if (!org.authEnabled) return true;
  return !org.loading && org.orgs.length > 0;
}

/** Kicks the startup migrations once, as soon as startupMigrationsReady. */
export function useStartupMigrations(): void {
  const ds = useDataSource();
  const ready = startupMigrationsReady(useOrg());
  useEffect(() => {
    if (ready) ds.kickStartupMigrations();
  }, [ready, ds]);
}
