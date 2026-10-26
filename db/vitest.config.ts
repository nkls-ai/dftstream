import { defineConfig } from "vitest/config";

// convex-test runs functions in-process; edge-runtime mirrors the Convex V8
// runtime. DFTSTREAM_AUTH_REQUIRED=1 turns on org enforcement for the suite.
export default defineConfig({
  test: {
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
    // CONVEX_SITE_URL is the issuer authz.parseCliSubject trusts for `cli|`
    // subjects; the suite needs a value to be able to forge/deny CLI tokens.
    env: {
      DFTSTREAM_AUTH_REQUIRED: "1",
      CONVEX_SITE_URL: "https://test.convex.site",
    },
  },
});
