import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { dirname, join, relative } from "node:path";

// Mechanical auth-boundary check, the UI twin of db's authzCoverage test.
// Provider SDKs may be imported ONLY by the adapter implementations in
// src/auth/adapters/. Anything else talks to the AuthAdapter interface
// (auth/AuthAdapter.ts, auth/AuthSession.tsx), so swapping or adding a
// provider never touches app code. A new direct import fails here.

const SRC = join(dirname(import.meta.dir), "");
const ADAPTERS_DIR = "auth/adapters/";

/** Whole modules that belong to a provider SDK. */
function isProviderModule(spec: string): boolean {
  return (
    spec.startsWith("@clerk/") ||
    spec === "@convex-dev/auth/react" ||
    spec.startsWith("@convex-dev/auth/react/") ||
    spec === "convex/react-clerk"
  );
}

/** convex/react is fine for data hooks, but its auth components are not. */
const CONVEX_REACT_AUTH_EXPORTS = new Set([
  "Authenticated",
  "Unauthenticated",
  "AuthLoading",
  "useConvexAuth",
  "ConvexProvider",
  "ConvexProviderWithAuth",
]);

type Violation = { file: string; spec: string; detail: string };

// `import … from "x"`, `export … from "x"`, side-effect `import "x"`, and
// dynamic `import("x")`. Multi-line specifier lists are matched lazily.
const STATIC_RE = /(?:import|export)\s+(?:type\s+)?([\s\S]*?)\s*from\s*["']([^"']+)["']/g;
const BARE_RE = /import\s*["']([^"']+)["']/g;
const DYNAMIC_RE = /import\(\s*["']([^"']+)["']\s*\)/g;

export function findViolations(file: string, source: string): Violation[] {
  const out: Violation[] = [];
  const check = (spec: string, names: string) => {
    if (isProviderModule(spec)) {
      out.push({ file, spec, detail: "provider SDK import" });
      return;
    }
    if (spec === "convex/react") {
      for (const raw of names.replace(/[{}]/g, " ").split(/[\s,]+/)) {
        const name = raw.replace(/^type$/, "");
        if (CONVEX_REACT_AUTH_EXPORTS.has(name)) {
          out.push({ file, spec, detail: `auth export ${name}` });
        }
      }
    }
  };
  for (const m of source.matchAll(STATIC_RE)) check(m[2]!, m[1]!);
  for (const m of source.matchAll(BARE_RE)) check(m[1]!, "");
  for (const m of source.matchAll(DYNAMIC_RE)) check(m[1]!, "");
  return out;
}

describe("auth import boundary", () => {
  test("provider SDKs are imported only under src/auth/adapters/", async () => {
    const violations: Violation[] = [];
    let scanned = 0;
    for await (const path of new Glob("**/*.{ts,tsx}").scan({ cwd: SRC })) {
      const rel = relative(SRC, join(SRC, path));
      if (rel.startsWith(ADAPTERS_DIR) || rel.endsWith("importBoundary.test.ts")) continue;
      const source = await Bun.file(join(SRC, path)).text();
      scanned++;
      violations.push(...findViolations(rel, source));
    }
    // Guard against a glob that silently matches nothing.
    expect(scanned).toBeGreaterThan(100);
    expect(violations).toEqual([]);
  });

  test("the scanner catches each forbidden shape", () => {
    const src = [
      'import { SignIn } from "@clerk/react";',
      'import {\n  useAuthActions,\n} from "@convex-dev/auth/react";',
      'import { ConvexProviderWithClerk } from "convex/react-clerk";',
      'import { useQuery, Authenticated } from "convex/react";',
      'export { useConvexAuth } from "convex/react";',
      'const m = import("@clerk/react/errors");',
    ].join("\n");
    expect(findViolations("x.tsx", src).map((v) => v.detail)).toEqual([
      "provider SDK import",
      "provider SDK import",
      "provider SDK import",
      "auth export Authenticated",
      "auth export useConvexAuth",
      "provider SDK import",
    ]);
  });

  test("data hooks from convex/react stay allowed", () => {
    const src = 'import { usePaginatedQuery, useQuery } from "convex/react";\nimport type { ConvexReactClient } from "convex/react";';
    expect(findViolations("x.ts", src)).toEqual([]);
  });
});
