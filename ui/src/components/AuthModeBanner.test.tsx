import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { AuthModeFrame } from "./AuthModeBanner";
import { AUTH_MODE_MISMATCH_MESSAGES, AuthModeMismatch } from "../auth/authModeMismatch";

const SHELL = <div id="app-shell">shell</div>;

describe("AuthModeFrame", () => {
  test("UI without auth in front of an enforcing backend: banner only, shell never mounted", () => {
    // Regression: the shell used to mount, its first org query threw, and
    // the fault screen replaced everything — banner included.
    const html = renderToString(
      <AuthModeFrame mismatch={AuthModeMismatch.UI_WITHOUT_AUTH}>{SHELL}</AuthModeFrame>,
    );
    expect(html).toContain("requires sign-in");
    expect(html).toContain("--auth-provider convex");
    expect(html).not.toContain("app-shell");
  });

  test("signed-in UI against a non-enforcing backend: warns but keeps the app", () => {
    const html = renderToString(
      <AuthModeFrame mismatch={AuthModeMismatch.BACKEND_WITHOUT_AUTH}>{SHELL}</AuthModeFrame>,
    );
    expect(html).toContain("Org isolation is OFF");
    expect(html).toContain("app-shell");
  });

  test("modes agree: no banner, app mounted", () => {
    const html = renderToString(
      <AuthModeFrame mismatch={AuthModeMismatch.NONE}>{SHELL}</AuthModeFrame>,
    );
    expect(html).not.toContain("auth-mode-banner");
    for (const m of Object.values(AUTH_MODE_MISMATCH_MESSAGES)) expect(html).not.toContain(m);
    expect(html).toContain("app-shell");
  });
});
