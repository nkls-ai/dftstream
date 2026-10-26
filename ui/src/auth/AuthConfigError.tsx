import { AuthProviderKind } from "./providerKind";

const VALID = [AuthProviderKind.CONVEX, AuthProviderKind.CLERK].join(" or ");

/**
 * Shown instead of the app when /dftstream-config.json names an auth
 * provider this UI does not know. Falling back to "no auth" would hand an
 * operator who typo'd --auth-provider an ungated UI, so we stop here.
 */
export function AuthConfigError({ raw }: { raw: string }) {
  return (
    <main className="login-screen" role="alert">
      <div className="login-panel auth-config-error">
        <h1>DFTStream is misconfigured</h1>
        <p>
          The UI was started with auth provider <code>{raw}</code>, which is not
          supported. Use <code>{VALID}</code>, or leave it empty for single-user
          mode without sign-in.
        </p>
        <p className="login-sub">
          Set it with <code>dftstream ui --auth-provider</code> or{" "}
          <code>DFTSTREAM_AUTH_PROVIDER</code>, then reload.
        </p>
      </div>
    </main>
  );
}
