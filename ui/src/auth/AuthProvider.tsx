import type { ReactNode } from "react";
import type { ConvexReactClient } from "convex/react";
import { AuthAdapterScope } from "./AuthSession";
import type { AuthProviderKind } from "./providerKind";
import { getAuthAdapter } from "./registry";

// Mounts the adapter for the configured provider kind (parsed once in
// frontend.tsx). Everything downstream reads useAuthSession()/useAuthAdapter()
// and never learns which provider is behind them.
export function AppAuthProvider({
  client,
  kind,
  clerkPublishableKey,
  children,
}: {
  client: ConvexReactClient;
  kind: AuthProviderKind;
  clerkPublishableKey?: string;
  children: ReactNode;
}) {
  const adapter = getAuthAdapter(kind);
  const { Provider } = adapter;
  return (
    <AuthAdapterScope adapter={adapter}>
      <Provider client={client} clerkPublishableKey={clerkPublishableKey}>
        {children}
      </Provider>
    </AuthAdapterScope>
  );
}
