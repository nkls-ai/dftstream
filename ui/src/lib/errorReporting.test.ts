import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  configureErrorReporting,
  installGlobalErrorHandlers,
  reportError,
} from "./errorReporting";

// The app can land on pages whose query string carries live secrets
// (e.g. /cli-link?code=... is a CLI-link bearer code). Error reports go to
// an operator-configured external endpoint and to console.error, so the
// query string must never appear in either.

const SECRET_HREF = "https://app.example.com/cli-link?code=SECRET#frag";

type Listener = (event: unknown) => void;

let listeners: Map<string, Listener[]>;
let consoleErrorCalls: unknown[][];
let fetchBodies: string[];

const originalWindow = (globalThis as { window?: unknown }).window;
const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;

beforeEach(() => {
  listeners = new Map();
  consoleErrorCalls = [];
  fetchBodies = [];

  (globalThis as { window?: unknown }).window = {
    location: {
      href: SECRET_HREF,
      pathname: "/cli-link",
      search: "?code=SECRET",
      hash: "#frag",
      origin: "https://app.example.com",
    },
    navigator: { userAgent: "bun-test-agent" },
    addEventListener: (type: string, fn: Listener) => {
      const existing = listeners.get(type) ?? [];
      listeners.set(type, [...existing, fn]);
    },
    removeEventListener: (type: string, fn: Listener) => {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((l) => l !== fn),
      );
    },
  };

  // Bun's built-in `navigator` has no sendBeacon, so deliver() falls through
  // to fetch; capture the body it would POST to the external endpoint.
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
    fetchBodies.push(String(init?.body));
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;

  console.error = (...args: unknown[]) => {
    consoleErrorCalls.push(args);
  };

  configureErrorReporting({
    endpoint: "https://errors.example.com/report",
    version: "test",
  });
});

afterEach(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
  configureErrorReporting({});
});

function serializeConsoleOutput(): string {
  return JSON.stringify(
    consoleErrorCalls.map((args) =>
      args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : a)),
    ),
  );
}

describe("reportError on a page with a secret in the query string", () => {
  test("delivered payload carries the pathname only and never the secret", () => {
    reportError(new Error("boom"), { source: "test" });

    expect(fetchBodies).toHaveLength(1);
    const payload = JSON.parse(fetchBodies[0]!) as { url: string };
    expect(payload.url).toBe("/cli-link");
    expect(fetchBodies[0]!).not.toContain("SECRET");
    expect(fetchBodies[0]!).not.toContain("code=");
    expect(fetchBodies[0]!).not.toContain("#frag");
  });

  test("console output never contains the secret", () => {
    reportError(new Error("boom"), { source: "test" });

    expect(consoleErrorCalls.length).toBeGreaterThan(0);
    const output = serializeConsoleOutput();
    expect(output).not.toContain("SECRET");
    expect(output).toContain("/cli-link");
  });
});

describe("installGlobalErrorHandlers on a page with a secret in the query string", () => {
  test("window.error reports url /cli-link and strips the query from filename", () => {
    const uninstall = installGlobalErrorHandlers();
    try {
      const onError = listeners.get("error")?.[0];
      expect(onError).toBeDefined();
      onError!({
        error: new Error("script exploded"),
        message: "script exploded",
        filename: "https://app.example.com/cli-link?code=SECRET",
        lineno: 12,
        colno: 3,
      });

      expect(fetchBodies).toHaveLength(1);
      const payload = JSON.parse(fetchBodies[0]!) as {
        url: string;
        metadata: { filename: string };
      };
      expect(payload.url).toBe("/cli-link");
      expect(payload.metadata.filename).toBe(
        "https://app.example.com/cli-link",
      );
      expect(fetchBodies[0]!).not.toContain("SECRET");
      expect(serializeConsoleOutput()).not.toContain("SECRET");
    } finally {
      uninstall();
    }
  });

  test("unhandledrejection reports url /cli-link with no secret anywhere", () => {
    const uninstall = installGlobalErrorHandlers();
    try {
      const onRejection = listeners.get("unhandledrejection")?.[0];
      expect(onRejection).toBeDefined();
      onRejection!({ reason: new Error("rejected") });

      expect(fetchBodies).toHaveLength(1);
      const payload = JSON.parse(fetchBodies[0]!) as { url: string };
      expect(payload.url).toBe("/cli-link");
      expect(fetchBodies[0]!).not.toContain("SECRET");
      expect(serializeConsoleOutput()).not.toContain("SECRET");
    } finally {
      uninstall();
    }
  });

  test("uninstall removes both listeners", () => {
    const uninstall = installGlobalErrorHandlers();
    uninstall();
    expect(listeners.get("error")).toEqual([]);
    expect(listeners.get("unhandledrejection")).toEqual([]);
  });
});
