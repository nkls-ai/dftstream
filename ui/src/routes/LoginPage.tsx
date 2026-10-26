import { useAuthAdapter } from "../auth/AuthSession";

// Shown by the App gate while signed out: whatever login surface the mounted
// auth adapter provides (our password form for convex-auth, Clerk's hosted
// <SignIn> for Clerk).
export function LoginPage() {
  const adapter = useAuthAdapter();
  if (!adapter) return null;
  const { LoginScreen } = adapter;
  return <LoginScreen />;
}
