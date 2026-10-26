/**
 * Direct-API isolation probes (matrix 4/5/9): call public functions and the
 * /api/artifact route as a given token against another org's ids.
 *
 *   TOKEN=<jwt> EXPECT=deny|allow EXP=… RUN=… ART=… ORG=… LEGACY_EXP=… bun api-probe.ts
 * Prints one line per probe; exit 1 if any probe disagrees with EXPECT.
 */
import { readFileSync } from "node:fs";
import { CONVEX_SITE, convexCall, check } from "./lib";

const token = process.env.TOKEN_FILE ? readFileSync(process.env.TOKEN_FILE, "utf8").trim() : (process.env.TOKEN ?? "") || null;
const expect = process.env.EXPECT ?? "deny";
const { EXP, RUN, ART, ORG } = process.env as Record<string, string>;

const probes: Array<[string, "query" | "mutation", string, Record<string, unknown>]> = [
  ["experiments.get", "query", "experiments:get", { id: EXP }],
  ["experiments.list(org)", "query", "experiments:list", { organizationId: ORG }],
  ["experiments.getByName", "query", "experiments:getByName", { name: "e2e-exp-a", organizationId: ORG }],
  ["experiments.listWithSummary", "query", "experiments:listWithSummary", { organizationId: ORG, paginationOpts: { numItems: 10, cursor: null } }],
  ["runs.get", "query", "runs:get", { runId: RUN }],
  ["runs.listByExperiment", "query", "runs:listByExperiment", { experimentId: EXP }],
  ["runs.listRunning(org)", "query", "runs:listRunning", { organizationId: ORG }],
  ["artifacts.listForRun", "query", "artifacts:listForRun", { runId: RUN }],
  ["artifacts.getContent", "query", "artifacts:getContent", { artifactId: ART }],
  ["organizations.members", "query", "organizations:members", { organizationId: ORG }],
  ["runs.setNotes (write)", "mutation", "runs:setNotes", { runId: RUN, notes: "e2e probe" }],
];

for (const [label, kind, path, args] of probes) {
  const r = await convexCall(kind, path, args, token);
  // A denial is an error, or an empty/null answer that leaks nothing.
  const leaked = r.status === "success" && r.value !== null && !(Array.isArray(r.value) && r.value.length === 0)
    && !(typeof r.value === "object" && r.value !== null && "page" in r.value && (r.value as { page: unknown[] }).page.length === 0);
  const ok = expect === "deny" ? !leaked : r.status === "success";
  check(ok, `${label}: ${r.status}${r.errorMessage ? " — " + r.errorMessage.split("\n").find((l) => l.startsWith("Uncaught"))?.slice(0, 90) : ""}`);
}
const res = await fetch(`${CONVEX_SITE}/api/artifact?id=${ART}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const artOk = expect === "deny" ? res.status === 401 || res.status === 403 : res.status === 200;
check(artOk, `GET /api/artifact → ${res.status}`);
