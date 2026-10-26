import { NOT_FOUND_OR_NO_ACCESS, isNotFoundOrNoAccess } from "./notFoundOrNoAccess";

export type ErrorSeverity = "error" | "fatal";

export interface ErrorReportContext {
  source: string;
  severity?: ErrorSeverity;
  action?: string;
  componentStack?: string;
  metadata?: Record<string, unknown>;
}

export interface ReportedError {
  incidentId: string;
  message: string;
}

interface ErrorReportingConfig {
  endpoint?: string;
  version?: string;
}

interface ErrorPayload {
  incidentId: string;
  source: string;
  severity: ErrorSeverity;
  action?: string;
  message: string;
  name?: string;
  stack?: string;
  componentStack?: string;
  metadata?: Record<string, unknown>;
  url: string;
  userAgent: string;
  version?: string;
  timestamp: string;
}

let config: ErrorReportingConfig = {};

export function configureErrorReporting(next: ErrorReportingConfig): void {
  config = {
    endpoint: normalizeEndpoint(next.endpoint),
    version: next.version,
  };
}

export function installGlobalErrorHandlers(): () => void {
  const onError = (event: ErrorEvent) => {
    reportError(event.error ?? event.message, {
      source: "window.error",
      severity: "fatal",
      metadata: {
        // Query/hash stripped: script URLs can carry cache-busters or tokens.
        filename: stripQueryAndHash(event.filename),
        lineno: event.lineno,
        colno: event.colno,
      },
    });
  };

  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    reportError(event.reason, {
      source: "window.unhandledrejection",
      severity: "fatal",
    });
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);

  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
  };
}

export function reportError(
  error: unknown,
  context: ErrorReportContext,
): ReportedError {
  const normalized = normalizeError(error);
  const incidentId = createIncidentId();
  const payload: ErrorPayload = {
    incidentId,
    source: context.source,
    severity: context.severity ?? "error",
    action: context.action,
    message: normalized.message,
    name: normalized.name,
    stack: normalized.stack,
    componentStack: context.componentStack,
    metadata: context.metadata,
    // Pathname only — never the query string or hash. Pages like
    // /cli-link?code=... carry live bearer codes in the query, and this
    // payload leaves the app (error endpoint) and hits the console.
    url: window.location.pathname,
    userAgent: window.navigator.userAgent,
    version: config.version,
    timestamp: new Date().toISOString(),
  };

  console.error(`[DFTStream ${incidentId}] ${payload.message}`, payload);
  deliver(payload);

  return { incidentId, message: normalized.message };
}

export function userErrorMessage(error: unknown, action: string): string {
  const { incidentId, message } = reportError(error, { source: "ui-action", action });
  // Never echo a refusal that says whether another org's record exists.
  if (isNotFoundOrNoAccess(error)) return `Could not ${action}: not found. ${NOT_FOUND_OR_NO_ACCESS}`;
  return `${message}\n\nIncident: ${incidentId}`;
}

function deliver(payload: ErrorPayload): void {
  if (!config.endpoint) return;

  const body = JSON.stringify(payload);
  try {
    if (navigator.sendBeacon) {
      const sent = navigator.sendBeacon(
        config.endpoint,
        new Blob([body], { type: "application/json" }),
      );
      if (sent) return;
    }

    void fetch(config.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch((err) => {
      console.warn("error report delivery failed", err);
    });
  } catch (err) {
    console.warn("error report delivery failed", err);
  }
}

/** Drop everything from the first `?` or `#` so secrets in query params never leak. */
function stripQueryAndHash(url: string): string {
  const cuts = [url.indexOf("?"), url.indexOf("#")].filter((i) => i !== -1);
  return cuts.length ? url.slice(0, Math.min(...cuts)) : url;
}

function createIncidentId(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
  const random =
    globalThis.crypto?.randomUUID?.().slice(0, 8) ??
    Math.random().toString(36).slice(2, 10);
  return `err_${stamp}_${random}`;
}

function normalizeEndpoint(endpoint: string | undefined): string | undefined {
  const trimmed = endpoint?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeError(error: unknown): {
  message: string;
  name?: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return {
      message: error.message || error.name,
      name: error.name,
      stack: error.stack,
    };
  }
  if (typeof error === "string") return { message: error };
  try {
    const json = JSON.stringify(error);
    return { message: json ?? String(error) };
  } catch { /* unserialisable value (cycle, BigInt): String() is the best message we can give */
    return { message: String(error) };
  }
}
