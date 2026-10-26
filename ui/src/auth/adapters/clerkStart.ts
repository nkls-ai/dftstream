// Whether Clerk failed to start. A bad or unreachable publishable key used to
// leave the page on "Loading…" forever: clerk-js never loads, so the Convex
// auth status never leaves LOADING. Clerk reports a failed script/boot as
// status "error"; a load that simply never finishes (a firewall that drops
// the request) is caught by a timeout.

export const ClerkStartProblem = {
  /** clerk-js reported a failed start (bad key, script blocked, boot error). */
  FAILED: "failed",
  /** clerk-js did not finish loading within CLERK_START_TIMEOUT_MS. */
  TIMED_OUT: "timedOut",
} as const;

export type ClerkStartProblem = (typeof ClerkStartProblem)[keyof typeof ClerkStartProblem];

/** How long Clerk may stay "loading" before the page says it cannot start. */
export const CLERK_START_TIMEOUT_MS = 15_000;

/** Clerk's own load status (ClerkStatus in @clerk/shared). */
export type ClerkLoadStatus = "loading" | "ready" | "degraded" | "error";

export function clerkStartProblem(status: ClerkLoadStatus, timedOut: boolean): ClerkStartProblem | null {
  if (status === "error") return ClerkStartProblem.FAILED;
  if (status === "loading" && timedOut) return ClerkStartProblem.TIMED_OUT;
  return null;
}
