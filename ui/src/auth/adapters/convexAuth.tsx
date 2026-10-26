import { useCallback, useMemo, useRef, type ReactNode } from "react";
import { ConvexAuthProvider, useAuthActions, useAuthToken } from "@convex-dev/auth/react";
import type { AuthAdapter, AuthProviderProps, AuthSession, PasswordCredentials } from "../AuthAdapter";
import { AuthSessionPublisher } from "../AuthSession";
import { PasswordLoginForm } from "../PasswordLoginForm";
import { AuthProviderKind } from "../providerKind";
import { useConvexAuthStatus } from "./convexStatus";

// convex-auth (self-hosted / manual installs): email + password against the
// deployment's own /api/auth routes. The id of the Password provider in
// db/convex/auth.ts.
const PASSWORD_PROVIDER_ID = "password";

function ConvexAuthSession({ children }: { children: ReactNode }) {
  const status = useConvexAuthStatus();
  const { signIn, signOut } = useAuthActions();
  // useAuthToken is reactive; the getter reads a ref so its identity (and the
  // artifact-fetch registration built on it) stays stable across renders.
  const token = useAuthToken();
  const tokenRef = useRef<string | null>(token ?? null);
  tokenRef.current = token ?? null;

  const getToken = useCallback(async () => tokenRef.current, []);
  const providerSignOut = useCallback(async () => {
    await signOut();
  }, [signOut]);
  const passwordSignIn = useCallback(
    async ({ flow, email, password, name }: PasswordCredentials) => {
      await signIn(PASSWORD_PROVIDER_ID, {
        email,
        password,
        flow,
        ...(name !== undefined ? { name } : {}),
      });
    },
    [signIn],
  );

  const session = useMemo<AuthSession>(
    () => ({ status, getToken, signOut: providerSignOut, passwordSignIn }),
    [status, getToken, providerSignOut, passwordSignIn],
  );
  return <AuthSessionPublisher session={session}>{children}</AuthSessionPublisher>;
}

function ConvexAuthAdapterProvider({ client, children }: AuthProviderProps) {
  return (
    <ConvexAuthProvider client={client}>
      <ConvexAuthSession>{children}</ConvexAuthSession>
    </ConvexAuthProvider>
  );
}

export const convexAuthAdapter: AuthAdapter = {
  kind: AuthProviderKind.CONVEX,
  gated: true,
  capabilities: { supportsPassword: true },
  Provider: ConvexAuthAdapterProvider,
  LoginScreen: PasswordLoginForm,
};
