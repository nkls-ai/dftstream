import { useState, type FormEvent } from "react";
import { PasswordFlow } from "./AuthAdapter";
import { useAuthSession } from "./AuthSession";

const MIN_PASSWORD = 8;

/**
 * Email + password sign-in / sign-up, for adapters with
 * capabilities.supportsPassword. Provider-neutral: it calls
 * useAuthSession().passwordSignIn and never imports a provider SDK.
 */
export function PasswordLoginForm() {
  const { passwordSignIn } = useAuthSession();
  const [flow, setFlow] = useState<PasswordFlow>(PasswordFlow.SIGN_IN);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signingIn = flow === PasswordFlow.SIGN_IN;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    // Client-side checks for fast, specific feedback. The backend re-validates
    // (auth.ts) — this is UX, not the security boundary.
    if (password.length < MIN_PASSWORD) {
      setError(`Password must be at least ${MIN_PASSWORD} characters`);
      return;
    }
    if (!passwordSignIn) {
      setError("This sign-in method is not available");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await passwordSignIn({
        flow,
        email,
        password,
        ...(signingIn ? {} : { name }),
      });
    } catch (err) {
      // Deliberately generic on screen — never surface raw backend/Convex
      // error text (distinguishing "no such user" from "wrong password" would
      // leak which emails are registered). The cause goes to the console for
      // whoever is debugging a misconfigured deployment.
      console.error("password sign-in failed", err);
      setError(
        signingIn
          ? "Email or password is incorrect"
          : "Could not create the account. The email may already be in use.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="login-panel" onSubmit={onSubmit}>
        <h1>DFTStream</h1>
        <p className="login-sub">{signingIn ? "Sign in to continue" : "Create your account"}</p>
        {!signingIn && (
          <label>
            Username
            <input
              type="text"
              autoComplete="username"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="how you'll show up to your team"
            />
          </label>
        )}
        <label>
          Email
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete={signingIn ? "current-password" : "new-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && <div className="login-error">{error}</div>}
        <button className="button" type="submit" disabled={busy}>
          {busy ? "…" : signingIn ? "Sign in" : "Sign up"}
        </button>
        <button
          type="button"
          className="login-toggle"
          onClick={() => {
            setError(null);
            setFlow(signingIn ? PasswordFlow.SIGN_UP : PasswordFlow.SIGN_IN);
          }}
        >
          {signingIn ? "Need an account? Sign up" : "Have an account? Sign in"}
        </button>
      </form>
    </div>
  );
}
