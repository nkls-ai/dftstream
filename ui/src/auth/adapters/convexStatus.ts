import { useConvexAuth } from "convex/react";
import { AuthStatus } from "../AuthAdapter";

/**
 * Session status as the CONVEX client sees it — the token was accepted by the
 * backend, not merely minted by the provider. Same source the old
 * <Authenticated>/<Unauthenticated> gate used, so gating is unchanged.
 */
export function useConvexAuthStatus(): AuthStatus {
  const { isLoading, isAuthenticated } = useConvexAuth();
  if (isLoading) return AuthStatus.LOADING;
  return isAuthenticated ? AuthStatus.SIGNED_IN : AuthStatus.SIGNED_OUT;
}
