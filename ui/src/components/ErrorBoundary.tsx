import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportError } from "../lib/errorReporting";

interface Props {
  children: ReactNode;
}

interface State {
  incidentId: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { incidentId: null };

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    const reported = reportError(error, {
      source: "react-error-boundary",
      severity: "fatal",
      componentStack: info.componentStack ?? undefined,
    });
    this.setState({ incidentId: reported.incidentId });
  }

  override render() {
    if (this.state.incidentId) {
      return (
        <main className="error-screen" role="alert">
          <div className="error-screen-panel">
            <div className="error-screen-kicker">Application error</div>
            <h1>DFTStream hit a UI fault.</h1>
            <p>
              The failure has been captured locally with an incident ID. Reload
              the app and include this ID when reporting the issue.
            </p>
            <code>{this.state.incidentId}</code>
            <button type="button" className="button" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </main>
      );
    }

    return this.props.children;
  }
}
