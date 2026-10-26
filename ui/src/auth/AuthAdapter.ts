import type { ComponentType, ReactNode } from "react";
import type { ConvexReactClient } from "convex/react";
import type { AuthProviderKind } from "./providerKind";

// The one seam between the app and whichever auth provider is mounted. App
// code (App.tsx gating, LoginPage, Org*, CliLinkPage, Sidebar, Settings, the
// artifact fetch path) talks only to these types. Provider SDKs — convex-auth,
// Clerk, convex/react's auth components — are imported ONLY by the
// implementations in ./adapters/ (enforced by auth/importBoundary.test.ts).
//
// Adding a provider: implement AuthAdapter in ./adapters/<name>.tsx, add a
// kind to providerKind.ts, and register it in ./registry.ts.

export const AuthStatus = {
  LOADING: "loading",
  SIGNED_IN: "signedIn",
  SIGNED_OUT: "signedOut",
} as const;

export type AuthStatus = (typeof AuthStatus)[keyof typeof AuthStatus];

export const PasswordFlow = {
  SIGN_IN: "signIn",
  SIGN_UP: "signUp",
} as const;

export type PasswordFlow = (typeof PasswordFlow)[keyof typeof PasswordFlow];

export interface PasswordCredentials {
  flow: PasswordFlow;
  email: string;
  password: string;
  /** Display name, sign-up only. */
  name?: string;
}

/** What a provider can do, so UI never asks "which provider is this?". */
export interface AuthCapabilities {
  /** Email + password sign-in/sign-up handled by our own form. */
  supportsPassword: boolean;
}

/**
 * The live session a mounted adapter publishes (see AuthSessionPublisher).
 * Every method is safe to call in any status.
 */
export interface AuthSession {
  status: AuthStatus;
  /** Raw provider sign-out; the app calls the wrapped useAuthSession().signOut. */
  signOut(): Promise<void>;
  /** The current Convex-audience JWT, or null when there is none. */
  getToken(): Promise<string | null>;
  /** Present only when capabilities.supportsPassword. Rejects on failure. */
  passwordSignIn?(credentials: PasswordCredentials): Promise<void>;
}

export interface AuthProviderProps {
  client: ConvexReactClient;
  /** Clerk publishable key; ignored by other adapters. */
  clerkPublishableKey?: string;
  children: ReactNode;
}

export interface AuthAdapter {
  kind: AuthProviderKind;
  /** False only for NONE: the app renders without a login gate or orgs. */
  gated: boolean;
  capabilities: AuthCapabilities;
  /**
   * Mounts the provider SDK + the Convex client provider, and publishes an
   * AuthSession to its subtree via AuthSessionPublisher.
   */
  Provider: ComponentType<AuthProviderProps>;
  /** Rendered by the app gate while signed out. */
  LoginScreen: ComponentType;
}
