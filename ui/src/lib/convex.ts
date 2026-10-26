import { ConvexReactClient } from "convex/react";

// Convex URL is resolved at runtime, not build time. The Go binary that
// hosts the bundle serves /dftstream-config.json with the URL the user
// configured (local backend or a hosted deployment); see
// wrapper/internal/uiserver. Callers must therefore construct the
// client *after* the config has been fetched.
export function createConvexClient(url: string): ConvexReactClient {
  return new ConvexReactClient(url);
}

export interface RuntimeConfig {
  convexUrl: string;
  version: string;
  errorReportUrl?: string;
  /** "convex" | "clerk" — empty/undefined means auth is disabled. */
  authProvider?: string;
  /** Clerk publishable key (clerk provider only). */
  clerkPublishableKey?: string;
  /** True when the serving Go binary exposes /api/local-file (Tools tab). */
  localFileEnabled?: boolean;
}

const DEFAULT_CONVEX_URL = "http://127.0.0.1:3210";

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  try {
    const res = await fetch("/dftstream-config.json", {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (res.ok) {
      const data = (await res.json()) as Partial<RuntimeConfig>;
      if (data && typeof data.convexUrl === "string" && data.convexUrl.length > 0) {
        return {
          convexUrl: data.convexUrl,
          version: data.version ?? "dev",
          errorReportUrl: data.errorReportUrl,
          authProvider: data.authProvider,
          clerkPublishableKey: data.clerkPublishableKey,
          localFileEnabled: data.localFileEnabled === true,
        };
      }
    }
  } catch {
    // Falls through to defaults — happens in `bun --hot` dev where the
    // Bun server doesn't expose the embedded config endpoint.
  }
  // Dev fallback: Bun-injected env vars (kept for `bun --hot` workflow, where
  // the Bun server doesn't serve /dftstream-config.json), then hard-coded
  // local defaults. Set BUN_PUBLIC_AUTH_PROVIDER=convex (+ optionally
  // BUN_PUBLIC_CLERK_PUBLISHABLE_KEY) to exercise the auth gate in dev.
  const envUrl = import.meta.env?.BUN_PUBLIC_CONVEX_URL;
  const errorReportUrl = import.meta.env?.BUN_PUBLIC_ERROR_REPORT_URL;
  const authProvider = import.meta.env?.BUN_PUBLIC_AUTH_PROVIDER;
  const clerkPublishableKey = import.meta.env?.BUN_PUBLIC_CLERK_PUBLISHABLE_KEY;
  return {
    convexUrl: envUrl || DEFAULT_CONVEX_URL,
    version: "dev",
    errorReportUrl,
    authProvider,
    clerkPublishableKey,
    // The Bun dev server has no Go binary behind it to read local paths.
    localFileEnabled: false,
  };
}
