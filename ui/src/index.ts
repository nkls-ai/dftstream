import { serve } from "bun";
import index from "./index.html";
import { isSupportedLocalFile, LOCAL_FILE_EXTENSIONS } from "./routes/toolsLocalFile";

// Serve the same /dftstream-config.json the Go `dftstream ui` server serves,
// so the dev UI discovers convexUrl + auth settings the canonical way (rather
// than relying on BUN_PUBLIC_* being inlined into the client bundle, which only
// the production build step does). Configure via env when launching:
//   BUN_PUBLIC_AUTH_PROVIDER=convex bun --hot src/index.ts
const runtimeConfig = {
  convexUrl: process.env.BUN_PUBLIC_CONVEX_URL || "http://127.0.0.1:3210",
  version: "dev",
  errorReportUrl: process.env.BUN_PUBLIC_ERROR_REPORT_URL || undefined,
  authProvider: process.env.BUN_PUBLIC_AUTH_PROVIDER || undefined,
  clerkPublishableKey: process.env.BUN_PUBLIC_CLERK_PUBLISHABLE_KEY || undefined,
  // The dev server runs on the same machine as the files, so it can serve
  // the Tools tab's local-path loading just like the Go binary does.
  localFileEnabled: true,
};

// Matches the Go endpoint's cap (wrapper/internal/uiserver/localfile.go).
const LOCAL_FILE_MAX_BYTES = 128 * 1024 * 1024;

// Dev twin of the Go binary's /api/local-file: absolute path, no "..",
// extension allowlist, size cap, read-only. Supports If-Modified-Since so
// the Tools tab's live-follow polling gets cheap 304s.
async function serveLocalFile(req: Request): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("method not allowed", { status: 405 });
  }
  const raw = new URL(req.url).searchParams.get("path") ?? "";
  if (raw.trim() === "") return new Response("missing path parameter", { status: 400 });
  if (raw.includes("..")) return new Response("path must not contain '..'", { status: 400 });
  if (!raw.startsWith("/")) return new Response("path must be absolute", { status: 400 });
  if (!isSupportedLocalFile(raw)) {
    return new Response(`extension not allowed (use ${LOCAL_FILE_EXTENSIONS.join(", ")})`, { status: 400 });
  }
  const file = Bun.file(raw);
  if (!(await file.exists())) return new Response(`file not found: ${raw}`, { status: 404 });
  if (file.size > LOCAL_FILE_MAX_BYTES) {
    return new Response(`file is ${file.size} bytes; limit is ${LOCAL_FILE_MAX_BYTES}`, { status: 413 });
  }
  const lastModified = new Date(file.lastModified);
  lastModified.setMilliseconds(0); // HTTP dates have second precision
  const ims = req.headers.get("if-modified-since");
  if (ims) {
    const since = new Date(ims);
    if (!Number.isNaN(since.getTime()) && lastModified <= since) {
      return new Response(null, { status: 304 });
    }
  }
  const headers = {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-cache",
    "Last-Modified": lastModified.toUTCString(),
    "X-File-Size": String(file.size),
  };
  if (req.method === "HEAD") return new Response(null, { status: 200, headers });
  try {
    return new Response(await file.arrayBuffer(), { status: 200, headers });
  } catch (err) {
    return new Response(`cannot read file: ${err instanceof Error ? err.message : String(err)}`, { status: 500 });
  }
}

const server = serve({
  routes: {
    "/dftstream-config.json": () =>
      Response.json(runtimeConfig, {
        headers: { "Cache-Control": "no-store" },
      }),

    "/api/local-file": serveLocalFile,

    // Serve index.html for all unmatched routes.
    "/*": index,
  },

  development: process.env.NODE_ENV !== "production" && {
    // Enable browser hot reloading in development
    hmr: true,

    // Echo console logs from the browser to the server
    console: true,
  },
});

console.log(`DFTStream dev server running at ${server.url}`);
console.log(
  `  auth: ${runtimeConfig.authProvider ?? "off"} · convex: ${runtimeConfig.convexUrl}`,
);
