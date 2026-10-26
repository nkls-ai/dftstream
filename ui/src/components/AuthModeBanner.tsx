import { useEffect, useState, type ReactNode } from "react";
import { useDataSource } from "../data/DataSource";
import {
  AUTH_MODE_MISMATCH_MESSAGES,
  AuthModeMismatch,
  mismatchBlocksApp,
} from "../auth/authModeMismatch";

/**
 * The backend's enforcement flag (meta.version's `authRequired`), probed once
 * per mount. null while loading, on an older backend without the field, or
 * when the probe failed — "unknown", which never triggers a banner.
 */
export function useBackendAuthRequired(): boolean | null {
  const ds = useDataSource();
  const [backendAuthRequired, setBackendAuthRequired] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    ds.getBackendAuthRequired()
      .then((required) => {
        if (!cancelled) setBackendAuthRequired(required);
      })
      .catch((err: unknown) => {
        // Unknown backend mode: no banner is the honest answer. The failure
        // itself (backend down, misconfigured flag) surfaces elsewhere too.
        console.warn("could not read backend auth mode (meta:version)", err);
      });
    return () => {
      cancelled = true;
    };
  }, [ds]);

  return backendAuthRequired;
}

/** Warns when the UI's auth mode disagrees with the backend's enforcement flag. */
export function AuthModeBanner({ mismatch }: { mismatch: AuthModeMismatch }) {
  if (mismatch === AuthModeMismatch.NONE) return null;
  return (
    <div className="auth-mode-banner" role="alert">
      {AUTH_MODE_MISMATCH_MESSAGES[mismatch]}
    </div>
  );
}

/**
 * The banner above the app, and the app itself only when it can work. A UI
 * without a login in front of a backend that requires one cannot run a single
 * org query: mounting the shell there used to crash it (the sidebar's first
 * query throws "organization required") into the full-page fault screen,
 * which hid the very banner that explains the fix. The shell is withheld
 * instead; every other mismatch only warns.
 */
export function AuthModeFrame({
  mismatch,
  children,
}: {
  mismatch: AuthModeMismatch;
  children: ReactNode;
}) {
  return (
    <>
      <AuthModeBanner mismatch={mismatch} />
      {mismatchBlocksApp(mismatch) ? null : children}
    </>
  );
}
