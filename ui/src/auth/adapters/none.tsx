import { ConvexProvider } from "convex/react";
import { AuthStatus, type AuthAdapter, type AuthProviderProps, type AuthSession } from "../AuthAdapter";
import { AuthSessionPublisher } from "../AuthSession";
import { AuthProviderKind } from "../providerKind";

// No auth: the single-user local install. A plain ConvexProvider, no login
// gate, no orgs, no token — requests go out bare, which the auth-disabled
// backend accepts. Identical to the pre-adapter behaviour.

const SESSION: AuthSession = {
  status: AuthStatus.SIGNED_IN,
  signOut: async () => {},
  getToken: async () => null,
};

function NoAuthProvider({ client, children }: AuthProviderProps) {
  return (
    <ConvexProvider client={client}>
      <AuthSessionPublisher session={SESSION}>{children}</AuthSessionPublisher>
    </ConvexProvider>
  );
}

// Never rendered: the app does not gate when `gated` is false.
function NoLoginScreen() {
  return null;
}

export const noneAdapter: AuthAdapter = {
  kind: AuthProviderKind.NONE,
  gated: false,
  capabilities: { supportsPassword: false },
  Provider: NoAuthProvider,
  LoginScreen: NoLoginScreen,
};
