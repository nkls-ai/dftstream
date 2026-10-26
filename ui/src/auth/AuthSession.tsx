import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { registerAuthTokenGetter } from "../lib/authToken";
import { AuthStatus, type AuthAdapter, type AuthSession } from "./AuthAdapter";
import { clearPerUserState } from "./perUserState";

// Provider-neutral session plumbing shared by every adapter. An adapter's
// Provider computes an AuthSession from its SDK and hands it to
// AuthSessionPublisher; the app reads it back with useAuthSession(). This
// file imports no provider SDK.

// No adapter mounted (tests, or a component rendered outside the app shell):
// behave like the no-auth install — nothing to sign out of, no token.
const NO_SESSION: AuthSession = {
  status: AuthStatus.SIGNED_IN,
  signOut: async () => {},
  getToken: async () => null,
};

const AuthSessionContext = createContext<AuthSession>(NO_SESSION);
const AuthAdapterContext = createContext<AuthAdapter | null>(null);

/** The live session. Its signOut also clears per-user browser state. */
export function useAuthSession(): AuthSession {
  return useContext(AuthSessionContext);
}

/** The mounted adapter (null outside AppAuthProvider). */
export function useAuthAdapter(): AuthAdapter | null {
  return useContext(AuthAdapterContext);
}

export function AuthAdapterScope({
  adapter,
  children,
}: {
  adapter: AuthAdapter;
  children: ReactNode;
}) {
  return <AuthAdapterContext.Provider value={adapter}>{children}</AuthAdapterContext.Provider>;
}

/**
 * The one sign-out every provider goes through: the provider's own sign-out,
 * then forget the previous user's browser state (active org, compare basket,
 * notification watermark) so the next person on a shared machine starts
 * clean. A failed provider sign-out rejects and leaves the state alone — the
 * user is still signed in, and the caller surfaces the error.
 */
export function wrapSignOut(
  providerSignOut: () => Promise<void>,
  clear: () => void = clearPerUserState,
): () => Promise<void> {
  return async () => {
    await providerSignOut();
    clear();
  };
}

/**
 * Publishes an adapter's session to the app and to the non-React artifact
 * fetch path (lib/authToken.ts). The token getter answers null unless the
 * session is signed in, so a signed-out tab never attaches a stale JWT.
 */
export function AuthSessionPublisher({
  session,
  children,
}: {
  session: AuthSession;
  children: ReactNode;
}) {
  const ref = useRef(session);
  ref.current = session;
  useEffect(() => {
    registerAuthTokenGetter(async () =>
      ref.current.status === AuthStatus.SIGNED_IN ? await ref.current.getToken() : null,
    );
    return () => registerAuthTokenGetter(null);
  }, []);
  const { status, signOut, getToken, passwordSignIn } = session;
  const value = useMemo<AuthSession>(
    () => ({ status, getToken, passwordSignIn, signOut: wrapSignOut(signOut) }),
    [status, signOut, getToken, passwordSignIn],
  );
  return <AuthSessionContext.Provider value={value}>{children}</AuthSessionContext.Provider>;
}
