// Which auth provider the UI mounts, parsed ONCE from
// /dftstream-config.json's `authProvider` (see lib/convex.ts). Everything
// else in the app branches on this enum, never on the raw string.

export const AuthProviderKind = {
  /** No auth: single-user local mode. Plain ConvexProvider, no login gate. */
  NONE: "none",
  /** convex-auth (email + password), self-hosted / manual installs. */
  CONVEX: "convex",
  /** Clerk (hosted teams). */
  CLERK: "clerk",
} as const;

export type AuthProviderKind = (typeof AuthProviderKind)[keyof typeof AuthProviderKind];

/** Result of parsing the configured provider name. */
export type ParsedAuthProvider =
  | { ok: true; kind: AuthProviderKind }
  | { ok: false; raw: string };

// The config values that select a real provider. NONE is deliberately absent:
// "no auth" is spelled as an empty/absent value, matching `dftstream ui`
// (which omits authProvider when --auth-provider is not given).
const CONFIGURABLE: ReadonlySet<string> = new Set([
  AuthProviderKind.CONVEX,
  AuthProviderKind.CLERK,
]);

/**
 * Parse `authProvider` from the runtime config. Empty/absent (or whitespace)
 * is NONE, exactly as before. Anything unrecognized is an error, never a
 * silent fallback to no-auth: an operator who typo'd `--auth-provider` must
 * not get an ungated UI.
 */
export function parseAuthProviderKind(raw: string | undefined | null): ParsedAuthProvider {
  const value = (raw ?? "").trim();
  if (value === "") return { ok: true, kind: AuthProviderKind.NONE };
  if (CONFIGURABLE.has(value)) return { ok: true, kind: value as AuthProviderKind };
  return { ok: false, raw: value };
}
