import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { ClerkProvider, SignIn, useAuth, useClerk } from "@clerk/react";
import { ClerkOfflineError } from "@clerk/react/errors";
import type { AuthAdapter, AuthProviderProps, AuthSession } from "../AuthAdapter";
import { AuthSessionPublisher } from "../AuthSession";
import { AuthStartError } from "../AuthStartError";
import { AuthProviderKind } from "../providerKind";
import { clerkTokenOptions } from "./clerkToken";
import { CLERK_START_TIMEOUT_MS, clerkStartProblem } from "./clerkStart";
import { useConvexAuthStatus } from "./convexStatus";

// Clerk (hosted teams). ConvexProviderWithClerk feeds Clerk's token to the
// Convex client; this adapter publishes the same token to the artifact fetch
// path and routes sign-out through Clerk. Clerk Core 3 (@clerk/react v6).

function ClerkSession({ children }: { children: ReactNode }) {
  const status = useConvexAuthStatus();
  const clerk = useClerk();
  const { getToken, sessionClaims } = useAuth();
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const audienceRef = useRef<unknown>(sessionClaims?.aud);
  audienceRef.current = sessionClaims?.aud;

  const token = useCallback(async () => {
    try {
      return await getTokenRef.current(clerkTokenOptions(audienceRef.current));
    } catch (err) {
      // Core 3: getToken throws ClerkOfflineError instead of returning null
      // when the browser is offline. Either way the artifact fetch must see
      // "no token" (a clean 401 it reports), not a crashed stream setup.
      if (ClerkOfflineError.is(err)) {
        console.warn("clerk token unavailable: offline");
      } else {
        console.error("clerk token fetch failed", err);
      }
      return null;
    }
  }, []);
  const providerSignOut = useCallback(async () => {
    await clerk.signOut();
  }, [clerk]);

  const session = useMemo<AuthSession>(
    () => ({ status, getToken: token, signOut: providerSignOut }),
    [status, token, providerSignOut],
  );
  return <AuthSessionPublisher session={session}>{children}</AuthSessionPublisher>;
}

// Replaces the app with an error screen when Clerk fails to start, instead of
// leaving it on "Loading…" forever. The app renders normally while loading.
function ClerkStartGuard({ children }: { children: ReactNode }) {
  const { status } = useClerk();
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (status !== "loading") return;
    const timer = setTimeout(() => setTimedOut(true), CLERK_START_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [status]);
  const problem = clerkStartProblem(status, timedOut);
  if (problem) return <AuthStartError problem={problem} />;
  return <>{children}</>;
}

function ClerkAdapterProvider({ client, clerkPublishableKey, children }: AuthProviderProps) {
  if (!clerkPublishableKey) {
    throw new Error(
      "authProvider is 'clerk' but clerkPublishableKey is missing in /dftstream-config.json",
    );
  }
  return (
    <ClerkProvider publishableKey={clerkPublishableKey}>
      <ClerkStartGuard>
        <ConvexProviderWithClerk client={client} useAuth={useAuth}>
          <ClerkSession>{children}</ClerkSession>
        </ConvexProviderWithClerk>
      </ClerkStartGuard>
    </ClerkProvider>
  );
}

function ClerkLoginScreen() {
  return (
    <div className="login-screen">
      <SignIn routing="hash" />
    </div>
  );
}

export const clerkAdapter: AuthAdapter = {
  kind: AuthProviderKind.CLERK,
  gated: true,
  capabilities: { supportsPassword: false },
  Provider: ClerkAdapterProvider,
  LoginScreen: ClerkLoginScreen,
};
