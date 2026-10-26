// The UI picks its auth mode from its own runtime config (`dftstream ui
// --auth-provider`), while the backend enforces from DFTSTREAM_AUTH_REQUIRED.
// The two are configured separately and can disagree; this decides whether
// (and how) to warn. Pure, so it is unit tested without React.

export const AuthModeMismatch = {
  /** Modes agree, or the backend did not say (older backend / probe failed). */
  NONE: "none",
  /** Backend enforces sign-in, but the UI mounts no login. Every org query fails. */
  UI_WITHOUT_AUTH: "uiWithoutAuth",
  /** UI shows a login, but the backend runs with org isolation OFF. */
  BACKEND_WITHOUT_AUTH: "backendWithoutAuth",
} as const;

export type AuthModeMismatch = (typeof AuthModeMismatch)[keyof typeof AuthModeMismatch];

/**
 * @param uiGated whether the UI mounted a sign-in gate (adapter.gated)
 * @param backendAuthRequired meta.version's `authRequired`, or null when the
 *   backend did not report it (field absent on older backends, or the probe
 *   failed) — no banner then, since we cannot know.
 */
export function authModeMismatch(
  uiGated: boolean,
  backendAuthRequired: boolean | null,
): AuthModeMismatch {
  if (backendAuthRequired === null || backendAuthRequired === uiGated) {
    return AuthModeMismatch.NONE;
  }
  return backendAuthRequired
    ? AuthModeMismatch.UI_WITHOUT_AUTH
    : AuthModeMismatch.BACKEND_WITHOUT_AUTH;
}

/**
 * Whether the app cannot work at all under this mismatch. Only a UI without a
 * login in front of an enforcing backend: every org query it sends is
 * refused, so there is nothing to show but the fix. A signed-in UI against a
 * non-enforcing backend works (unprotected) and only warns.
 */
export function mismatchBlocksApp(mismatch: AuthModeMismatch): boolean {
  return mismatch === AuthModeMismatch.UI_WITHOUT_AUTH;
}

export const AUTH_MODE_MISMATCH_MESSAGES: Record<
  Exclude<AuthModeMismatch, typeof AuthModeMismatch.NONE>,
  string
> = {
  [AuthModeMismatch.UI_WITHOUT_AUTH]:
    "This backend requires sign-in, but the UI was started without an auth provider. " +
    "Start it with `dftstream ui --auth-provider convex` (or `clerk`).",
  [AuthModeMismatch.BACKEND_WITHOUT_AUTH]:
    "Org isolation is OFF on this backend (DFTSTREAM_AUTH_REQUIRED is not set). " +
    "Signing in does not protect data: anyone who can reach the backend can read and change it.",
};
