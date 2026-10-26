// Process-wide registry for the current auth token, so non-React fetch paths
// (artifact body downloads in lib/streamArtifact.ts) can attach the caller's
// JWT without threading a getter through every call site.
//
// Artifact bodies are served by the backend's authenticated /api/artifact
// route — queries no longer return storage URLs (they never expire, so a
// recorded one out-lived org membership). The route validates the same JWT
// the Convex WebSocket uses; whichever auth provider is mounted
// (auth/AuthProvider.tsx) registers a getter here. When no provider is
// mounted (single-user local mode) the getter stays null and requests go out
// bare, which the auth-disabled backend accepts.

let getter: (() => Promise<string | null>) | null = null;

/** Called by the mounted auth provider. Pass null on unmount/sign-out. */
export function registerAuthTokenGetter(
  fn: (() => Promise<string | null>) | null,
): void {
  getter = fn;
}

/** The current JWT, or null when unauthenticated / auth is disabled. */
export async function getAuthToken(): Promise<string | null> {
  if (!getter) return null;
  return await getter();
}
