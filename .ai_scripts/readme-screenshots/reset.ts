/**
 * Removes the README-screenshot experiments from the LOCAL backend so seed.sh
 * can re-import them fresh. Only touches the names passed on the command line.
 *
 *   bun .ai_scripts/readme-screenshots/reset.ts water-pes-scans co2-protonation-ts ...
 */
const CONVEX_URL = "http://127.0.0.1:3210"; // local only, never a cloud deployment

async function call(kind: "query" | "mutation", path: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${CONVEX_URL}/api/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const body = (await res.json()) as { status?: string; value?: unknown; errorMessage?: string };
  if (!res.ok || body.status !== "success") throw new Error(`${path}: ${body.errorMessage ?? `HTTP ${res.status}`}`);
  return body.value;
}

for (const name of process.argv.slice(2)) {
  const exp = (await call("query", "experiments:getByName", { name })) as { _id: string } | null;
  if (!exp) {
    console.log(`- ${name}: not present`);
    continue;
  }
  await call("mutation", "experiments:remove", { experimentId: exp._id });
  console.log(`- ${name}: removed`);
}
