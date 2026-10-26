import { useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AuthStatus } from "./auth/AuthAdapter";
import { useAuthAdapter, useAuthSession } from "./auth/AuthSession";
import { AuthModeFrame, useBackendAuthRequired } from "./components/AuthModeBanner";
import { authModeMismatch } from "./auth/authModeMismatch";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Sidebar } from "./components/Sidebar";
import { ExperimentsPage } from "./routes/ExperimentsPage";
import { RunsPage } from "./routes/RunsPage";
import { RunDetailPage } from "./routes/RunDetailPage";
import { PathwayPage } from "./routes/PathwayPage";
import { SettingsPage } from "./routes/SettingsPage";
import { LoginPage } from "./routes/LoginPage";
import { CliLinkPage } from "./routes/CliLinkPage";
import { OrgProvider } from "./auth/OrgContext";
import { NotificationProvider } from "./components/Notifications";
import { CommandPalette } from "./components/CommandPalette";
import { RouteErrorBoundaryProvider } from "./components/RouteErrorBoundary";
import { ComparePage, CompareBasketPill } from "./routes/ComparePage";
import { ToolsPage } from "./routes/ToolsPage";
import { InputBuilderPage } from "./routes/InputBuilderPage";
import { useSettings } from "./lib/settings";
import { useStartupMigrations } from "./lib/startupMigrations";
import "./index.css";

export function App() {
  const gated = useAuthAdapter()?.gated ?? false;
  const mismatch = authModeMismatch(gated, useBackendAuthRequired());
  // The shell gets its own boundary so a crash before the backend-mode probe
  // answers (the mismatched shell's first query can fail first) never takes
  // the banner down with it; once the probe lands, the frame drops the shell.
  return (
    <AuthModeFrame mismatch={mismatch}>
      <ErrorBoundary>{gated ? <AuthGate /> : <AppShell />}</ErrorBoundary>
    </AuthModeFrame>
  );
}

// Auth enabled → gate on the adapter's session status (the Convex client's
// view of the token, as before).
function AuthGate() {
  const { status } = useAuthSession();
  switch (status) {
    case AuthStatus.LOADING:
      return <div className="login-screen">Loading…</div>;
    case AuthStatus.SIGNED_OUT:
      return <LoginPage />;
    case AuthStatus.SIGNED_IN:
      return (
        <OrgProvider authEnabled>
          <AppShell />
        </OrgProvider>
      );
  }
}

function AppShell() {
  const [settings] = useSettings();
  useStartupMigrations();
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", settings.theme);
  }, [settings.theme]);

  return (
    <NotificationProvider>
    <div
      className="app"
      style={
        {
          "--sidebar-width": settings.sidebarCollapsed ? "56px" : "220px",
        } as React.CSSProperties
      }
    >
      <Sidebar />
      <CommandPalette />
      <CompareBasketPill />
      <main className="main">
        {/* Scoped to the routed page so a failing query cannot take the whole
            shell down, and clears itself on navigation. */}
        <RouteErrorBoundaryProvider>
        <Routes>
          <Route path="/" element={<Navigate to="/experiments" replace />} />
          <Route path="/experiments" element={<ExperimentsPage />} />
          <Route path="/experiments/:expId" element={<RunsPage />} />
          <Route
            path="/experiments/:expId/runs/:runId"
            element={<RunDetailPage />}
          />
          <Route
            path="/experiments/:expId/pathways/:pathwayId"
            element={<PathwayPage />}
          />
          <Route path="/tools" element={<ToolsPage />} />
          <Route path="/new-input" element={<InputBuilderPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/cli-link" element={<CliLinkPage />} />
          <Route path="/compare" element={<ComparePage />} />
          <Route
            path="*"
            element={<div className="empty-state">Not found.</div>}
          />
        </Routes>
        </RouteErrorBoundaryProvider>
      </main>
    </div>
    </NotificationProvider>
  );
}

export default App;
