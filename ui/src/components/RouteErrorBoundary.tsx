import { Component, type ErrorInfo, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { reportError, userErrorMessage } from "../lib/errorReporting";
import { entityForPath, isNotFoundOrNoAccess } from "../lib/notFoundOrNoAccess";
import { NotFoundState } from "./NotFoundState";

/**
 * Error boundary scoped to the routed page, sitting inside the app shell.
 *
 * The app had exactly one boundary, above <BrowserRouter> in frontend.tsx. That
 * makes any render-time throw fatal for the whole application: convex/react's
 * useQuery rethrows a failed query during render (see the `result instanceof
 * Error` branch in convex/dist/esm/react/client.js), so one broken server-side
 * query — the observed case was experiments:listWithSummary — replaced the
 * sidebar, the command palette and every route with a full-screen "reload the
 * app" panel. The chemist could not even navigate to a different experiment.
 *
 * This boundary keeps the shell alive and confines the failure to <main>. It
 * also resets on navigation (the `resetKey` prop, driven by the pathname), so
 * clicking another experiment recovers without a page load — the root boundary
 * latches permanently and cannot do that.
 *
 * The root boundary stays where it is: it is still the net for a throw in the
 * shell itself, or in a provider above the router.
 */

interface Props {
  children: ReactNode;
  /** Changing this clears the error. Pass the current pathname. */
  resetKey: string;
}

interface State {
  incidentId: string | null;
  message: string | null;
  /** The page's record is missing or another org's: shown as not found. */
  notFound: boolean;
  resetKey: string;
}

export class RouteErrorBoundary extends Component<Props, State> {
  override state: State = {
    incidentId: null,
    message: null,
    notFound: false,
    resetKey: this.props.resetKey,
  };

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.resetKey) {
      // Navigated away from the page that threw — drop the error and let the
      // new route render normally.
      return { incidentId: null, message: null, notFound: false, resetKey: props.resetKey };
    }
    return null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    if (isNotFoundOrNoAccess(error)) {
      // Opening another org's record by URL: logged for diagnosis, but the
      // page shows the same "not found" as a missing id, never the raw text.
      const reported = reportError(error, { source: "react-route-boundary", action: "load this page" });
      this.setState({ incidentId: reported.incidentId, message: null, notFound: true });
      return;
    }
    const reported = reportError(error, {
      source: "react-route-boundary",
      severity: "error",
      componentStack: info.componentStack ?? undefined,
    });
    this.setState({
      incidentId: reported.incidentId,
      message: userErrorMessage(error, "load this page"),
    });
  }

  private retry = () => {
    this.setState({ incidentId: null, message: null, notFound: false });
  };

  override render() {
    if (this.state.incidentId === null) return this.props.children;
    if (this.state.notFound) return <NotFoundState entity={entityForPath(this.state.resetKey)} />;
    return (
      <div className="empty-state" role="alert">
        <h2>This page failed to load.</h2>
        <p>{this.state.message}</p>
        <p className="muted">
          The rest of the app still works — use the sidebar to go somewhere else,
          or try again.
        </p>
        <code className="mono">{this.state.incidentId}</code>
        <div style={{ marginTop: 12 }}>
          <button type="button" className="button" onClick={this.retry}>
            Try again
          </button>
        </div>
      </div>
    );
  }
}

/** Wraps `children` in a boundary that clears itself whenever the route changes. */
export function RouteErrorBoundaryProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  return (
    <RouteErrorBoundary resetKey={location.pathname}>{children}</RouteErrorBoundary>
  );
}
