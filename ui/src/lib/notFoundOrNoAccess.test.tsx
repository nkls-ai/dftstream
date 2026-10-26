import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { EntityKind, entityForPath, isNotFoundOrNoAccess } from "./notFoundOrNoAccess";
import { userErrorMessage } from "./errorReporting";
import { RouteErrorBoundary } from "../components/RouteErrorBoundary";
import { NotFoundState } from "../components/NotFoundState";

// What convex/react throws from useQuery when a member opens another org's run.
const FOREIGN_RUN = new Error(
  "[CONVEX Q(runs:get)] [Request ID: 1a2b] Server Error\nUncaught Error: not a member of this organization\n    at requireMembership (../convex/authz.ts:244:24)",
);
const MALFORMED_ID = new Error(
  "[CONVEX Q(runs:get)] ArgumentValidationError: Value does not match validator.\nPath: .runId\nValue: \"nope\"\nValidator: v.id(\"runs\")",
);

const originalWindow = (globalThis as { window?: unknown }).window;
const originalConsoleError = console.error;
beforeEach(() => {
  (globalThis as { window?: unknown }).window = {
    location: { pathname: "/experiments/e/runs/r" },
    navigator: { userAgent: "bun-test-agent" },
  };
  console.error = () => { /* reportError logs every incident; silence it in tests */ };
});
afterEach(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
  console.error = originalConsoleError;
});

describe("isNotFoundOrNoAccess", () => {
  test("foreign-org, deleted-parent and malformed-id refusals are not-found", () => {
    expect(isNotFoundOrNoAccess(FOREIGN_RUN)).toBe(true);
    expect(isNotFoundOrNoAccess(MALFORMED_ID)).toBe(true);
    expect(isNotFoundOrNoAccess(new Error("Uncaught Error: experiment not found"))).toBe(true);
  });

  test("other failures keep their real message", () => {
    expect(isNotFoundOrNoAccess(new Error("Uncaught Error: insufficient permission"))).toBe(false);
    expect(isNotFoundOrNoAccess(new Error("network down"))).toBe(false);
    expect(isNotFoundOrNoAccess(undefined)).toBe(false);
  });
});

test("entityForPath follows the detail route shapes", () => {
  expect(entityForPath("/experiments/e")).toBe(EntityKind.EXPERIMENT);
  expect(entityForPath("/experiments/e/runs/r")).toBe(EntityKind.RUN);
  expect(entityForPath("/experiments/e/pathways/p")).toBe(EntityKind.PATHWAY);
  expect(entityForPath("/settings")).toBe(EntityKind.PAGE);
});

// Regression: a member opening another org's run by URL saw the backend's raw
// "not a member of this organization", which confirms the run exists.
test("the route boundary shows a foreign run exactly like a missing one", () => {
  const boundary = new RouteErrorBoundary({ resetKey: "/experiments/e/runs/r", children: null });
  boundary.setState = (patch) => { Object.assign(boundary.state, patch); };
  boundary.componentDidCatch(FOREIGN_RUN, { componentStack: "" });
  const denied = renderToString(<MemoryRouter>{boundary.render()}</MemoryRouter>);
  const missing = renderToString(<MemoryRouter><NotFoundState entity={EntityKind.RUN} /></MemoryRouter>);
  expect(denied).toBe(missing);
  expect(denied).toContain("Run not found");
  expect(denied).not.toContain("member");
  expect(denied).not.toContain("failed to load");
});

test("userErrorMessage never echoes an access refusal", () => {
  const msg = userErrorMessage(FOREIGN_RUN, "set the parent run");
  expect(msg).toContain("not found");
  expect(msg).not.toContain("member");
  expect(userErrorMessage(new Error("disk full"), "upload")).toContain("disk full");
});
