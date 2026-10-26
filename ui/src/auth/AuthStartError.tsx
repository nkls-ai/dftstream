import { ClerkStartProblem } from "./adapters/clerkStart";

const HEADLINE: Record<ClerkStartProblem, string> = {
  [ClerkStartProblem.FAILED]: "Sign-in could not start",
  [ClerkStartProblem.TIMED_OUT]: "Sign-in is not responding",
};

/**
 * Shown instead of an endless "Loading…" when the Clerk sign-in service fails
 * to start. Names the two causes an operator or user can act on: the
 * configured publishable key, and the network path to Clerk.
 */
export function AuthStartError({ problem }: { problem: ClerkStartProblem }) {
  return (
    <main className="login-screen" role="alert">
      <div className="login-panel auth-config-error">
        <h1>{HEADLINE[problem]}</h1>
        <p>
          The Clerk sign-in service did not load. Either the configured publishable key is
          wrong, or this browser cannot reach Clerk.
        </p>
        <p className="login-sub">
          Configuration: check <code>dftstream ui --clerk-publishable-key</code> or{" "}
          <code>DFTSTREAM_CLERK_PUBLISHABLE_KEY</code> (a <code>pk_…</code> key from the
          Clerk dashboard). Network: check the connection, a firewall, or an ad blocker
          that blocks Clerk. Then reload.
        </p>
      </div>
    </main>
  );
}
