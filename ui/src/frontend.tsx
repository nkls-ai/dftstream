import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { AppAuthProvider } from "./auth/AuthProvider";
import { AuthConfigError } from "./auth/AuthConfigError";
import { parseAuthProviderKind } from "./auth/providerKind";
import { createConvexClient, loadRuntimeConfig } from "./lib/convex";
import { loadInitialTheme } from "./lib/settings";
import { migrateLegacyStorageKeys } from "./lib/legacyStorage";
import { DataSourceProvider } from "./data/DataSource";
import { ConvexDataSource } from "./data/ConvexDataSource";
import { DialogProvider } from "./components/Confirm";
import { ErrorBoundary } from "./components/ErrorBoundary";
import {
  configureErrorReporting,
  installGlobalErrorHandlers,
  reportError,
} from "./lib/errorReporting";
import logoUrl from "../../assets/logo.png";

installGlobalErrorHandlers();

// Bundler-resolved favicon — link the imported asset URL into the
// document head so it survives builds (Bun's bundler rewrites the
// import to a fingerprinted /logo-<hash>.png URL).
{
  const link =
    (document.querySelector("link[rel='icon']") as HTMLLinkElement | null) ??
    Object.assign(document.createElement("link"), { rel: "icon" });
  link.type = "image/png";
  link.href = logoUrl;
  if (!link.isConnected) document.head.appendChild(link);
}

async function bootstrap() {
  try {
    migrateLegacyStorageKeys(window.localStorage);
  } catch (err) {
    // localStorage itself is unavailable (e.g. blocked site data): nothing to migrate.
    console.warn("skipped migrating pre-rename settings:", err);
  }
  // loadInitialTheme handles missing/corrupt storage internally.
  document.documentElement.setAttribute("data-theme", loadInitialTheme());

  const elem = document.getElementById("root")!;
  const cfg = await loadRuntimeConfig();
  configureErrorReporting({
    endpoint: cfg.errorReportUrl,
    version: cfg.version,
  });
  window.__DFTSTREAM_VERSION__ = cfg.version;
  window.__DFTSTREAM_LOCAL_FILES__ = cfg.localFileEnabled === true;
  const convex = createConvexClient(cfg.convexUrl);
  const datasource = new ConvexDataSource(convex, cfg.convexUrl);
  const auth = parseAuthProviderKind(cfg.authProvider);

  const tree = (
    <StrictMode>
      <ErrorBoundary>
        {auth.ok ? (
          <AppAuthProvider
            client={convex}
            kind={auth.kind}
            clerkPublishableKey={cfg.clerkPublishableKey}
          >
            <DataSourceProvider value={datasource}>
              <DialogProvider>
                <BrowserRouter>
                  <App />
                </BrowserRouter>
              </DialogProvider>
            </DataSourceProvider>
          </AppAuthProvider>
        ) : (
          <AuthConfigError raw={auth.raw} />
        )}
      </ErrorBoundary>
    </StrictMode>
  );

  if (import.meta.hot) {
    const root: Root = (import.meta.hot.data.root ??= createRoot(elem));
    root.render(tree);
  } else {
    createRoot(elem).render(tree);
  }
}

void bootstrap().catch((err) => {
  const reported = reportError(err, {
    source: "bootstrap",
    severity: "fatal",
  });
  const elem = document.getElementById("root");
  if (elem) {
    elem.textContent = "";
    const main = document.createElement("main");
    main.className = "error-screen";
    main.setAttribute("role", "alert");
    const panel = document.createElement("div");
    panel.className = "error-screen-panel";
    panel.innerHTML = `
      <div class="error-screen-kicker">Startup error</div>
      <h1>DFTStream could not start.</h1>
      <p>The startup failure was captured locally with this incident ID.</p>
    `;
    const code = document.createElement("code");
    code.textContent = reported.incidentId;
    panel.appendChild(code);
    const btn = document.createElement("button");
    btn.className = "button";
    btn.type = "button";
    btn.textContent = "Reload";
    btn.onclick = () => window.location.reload();
    panel.appendChild(btn);
    main.appendChild(panel);
    elem.appendChild(main);
  }
});
