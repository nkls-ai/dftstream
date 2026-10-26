import type { AuthAdapter } from "./AuthAdapter";
import { AuthProviderKind } from "./providerKind";
import { clerkAdapter } from "./adapters/clerk";
import { convexAuthAdapter } from "./adapters/convexAuth";
import { noneAdapter } from "./adapters/none";

// Every auth adapter, keyed by kind. Record<AuthProviderKind, …> makes adding
// a kind a compile error here until its adapter is registered.
export const AUTH_ADAPTERS: Record<AuthProviderKind, AuthAdapter> = {
  [AuthProviderKind.NONE]: noneAdapter,
  [AuthProviderKind.CONVEX]: convexAuthAdapter,
  [AuthProviderKind.CLERK]: clerkAdapter,
};

export function getAuthAdapter(kind: AuthProviderKind): AuthAdapter {
  return AUTH_ADAPTERS[kind];
}
