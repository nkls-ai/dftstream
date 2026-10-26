import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { RouteErrorBoundary } from "./RouteErrorBoundary";

// getDerivedStateFromProps is the whole reset contract: without it the
// boundary latches on the first throw and the only escape is a full page
// reload — which is exactly the behaviour of the single root boundary this
// one exists to avoid.
const derive = RouteErrorBoundary.getDerivedStateFromProps;

const errored = {
  incidentId: "err_1",
  message: "boom",
  notFound: false,
  resetKey: "/experiments/abc",
};

test("navigating to another route clears a latched error", () => {
  const next = derive(
    { children: null, resetKey: "/experiments/xyz" },
    errored,
  );
  expect(next).toEqual({
    incidentId: null,
    message: null,
    notFound: false,
    resetKey: "/experiments/xyz",
  });
});

test("re-rendering the same route keeps the error on screen", () => {
  // Returning null means "no state change" — the fallback must not flicker
  // back to the broken page on every unrelated re-render.
  expect(derive({ children: null, resetKey: errored.resetKey }, errored)).toBeNull();
});

test("a healthy route renders its children untouched", () => {
  const html = renderToString(
    <RouteErrorBoundary resetKey="/experiments">
      <div>runs table</div>
    </RouteErrorBoundary>,
  );
  expect(html).toContain("runs table");
  expect(html).not.toContain("failed to load");
});
