/**
 * Logging reverse proxy for the Convex HTTP API: records, per request, the
 * method, path, the Convex function path (from the JSON body) and whether an
 * Authorization header was sent — never the token itself.
 *
 *   PROXY_PORT=3299 PROXY_TARGET=http://127.0.0.1:3210 PROXY_LOG=/tmp/x.jsonl bun proxy.ts
 */
import { appendFileSync } from "node:fs";

const port = Number(process.env.PROXY_PORT ?? 3299);
const target = process.env.PROXY_TARGET ?? "http://127.0.0.1:3210";
const log = process.env.PROXY_LOG ?? "proxy.jsonl";

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
    let fn: string | undefined;
    if (body) {
      try {
        fn = (JSON.parse(new TextDecoder().decode(body)) as { path?: string }).path;
      } catch { /* not a JSON function call (e.g. a blob upload); logged without a path */ }
    }
    const auth = req.headers.get("authorization");
    appendFileSync(log, JSON.stringify({
      t: Date.now(), method: req.method, path: url.pathname, fn,
      auth: auth === null ? null : auth.split(" ")[0],
    }) + "\n");
    const headers = new Headers(req.headers);
    headers.delete("host");
    const res = await fetch(target + url.pathname + url.search, { method: req.method, headers, body });
    return new Response(res.body, { status: res.status, headers: res.headers });
  },
});
console.log(`proxy ${port} -> ${target}, log ${log}`);
