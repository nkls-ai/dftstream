/** Prints { experiment: { id, runs: { runName: runId }, batches } } for the local backend. */
const URL_ = "http://127.0.0.1:3210"; // local only
async function q(path: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${URL_}/api/query`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, args, format: "json" }) });
  const body = (await res.json()) as { status?: string; value?: unknown; errorMessage?: string };
  if (body.status !== "success") throw new Error(`${path}: ${body.errorMessage}`);
  return body.value;
}
export async function experimentIds(names: readonly string[]) {
  const out: Record<string, { id: string; runs: Record<string, string> }> = {};
  for (const name of names) {
    const exp = await q("experiments:getByName", { name });
    if (!exp) continue;
    const runs = (await q("runs:listByExperiment", { experimentId: exp._id })) as { _id: string; name: string }[];
    out[name] = { id: exp._id, runs: Object.fromEntries(runs.map((r) => [r.name, r._id])) };
  }
  return out;
}
if (import.meta.main) console.log(JSON.stringify(await experimentIds(process.argv.slice(2)), null, 1));
