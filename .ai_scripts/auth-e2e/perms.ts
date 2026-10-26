/**
 * Matrix 5 over the API: viewer / member / admin / owner permissions in one
 * org, incl. the owner invariants. Tokens are the UI's convex-auth JWTs.
 *
 *   TOK_DIR=… ORG=… EXP=… RUN=… M_A=… M_B=… M_C=… bun perms.ts
 */
import { readFileSync } from "node:fs";
import { convexCall, check } from "./lib";

const env = process.env as Record<string, string>;
const tok = (u: string) => readFileSync(`${env.TOK_DIR}/tok${u}.jwt`, "utf8").trim();
const { ORG, EXP, RUN, M_A, M_B, M_C } = env;
const why = (r: { errorMessage?: string }) => r.errorMessage?.split("\n").find((l) => l.startsWith("Uncaught"))?.slice(15, 100) ?? "";

async function expectCall(who: string, want: "allow" | "deny", kind: "query" | "mutation", path: string, args: Record<string, unknown>, label = path) {
  const r = await convexCall(kind, path, args, tok(who));
  const ok = want === "allow" ? r.status === "success" : r.status !== "success";
  check(ok, `${who} ${want.padEnd(5)} ${label}: ${r.status} ${why(r)}`);
  return r;
}

// viewer (C)
await expectCall("C", "allow", "query", "experiments:get", { id: EXP }, "read experiment");
await expectCall("C", "deny", "mutation", "runs:setNotes", { runId: RUN, notes: "viewer" }, "write run notes");
await expectCall("C", "deny", "mutation", "experiments:ensure", { name: "e2e-viewer-exp", organizationId: ORG }, "create experiment");
await expectCall("C", "deny", "mutation", "organizations:addMember", { organizationId: ORG, email: "x@example.test", role: "viewer" }, "add member");
await expectCall("C", "deny", "query", "machineTokens:list", { organizationId: ORG }, "list machine tokens");
// member (B)
await expectCall("B", "allow", "mutation", "experiments:ensure", { name: "e2e-exp-b-in-a", organizationId: ORG }, "create own experiment");
// Notes/tags are shared run data (member+ on any run, docs/auth.md); rename is creator-or-admin.
await expectCall("B", "allow", "mutation", "runs:setNotes", { runId: RUN, notes: "e2e member note" }, "annotate A's run");
await expectCall("B", "deny", "mutation", "runs:rename", { runId: RUN, name: "e2e-renamed-by-member" }, "rename A's run");
await expectCall("B", "deny", "mutation", "experiments:rename", { experimentId: EXP, name: "e2e-renamed" }, "rename A's experiment");
await expectCall("B", "deny", "mutation", "organizations:updateRole", { membershipId: M_C, role: "member" }, "change a role");
await expectCall("B", "deny", "mutation", "machineTokens:create", { organizationId: ORG, name: "e2e-member-token" }, "mint machine token");
// promote B to admin (owner A)
await expectCall("A", "allow", "mutation", "organizations:updateRole", { membershipId: M_B, role: "admin" }, "promote B to admin");
await expectCall("B", "allow", "mutation", "runs:setNotes", { runId: RUN, notes: "e2e admin note" }, "admin edits A's run");
await expectCall("B", "deny", "mutation", "organizations:updateRole", { membershipId: M_A, role: "member" }, "admin demotes owner");
await expectCall("B", "deny", "mutation", "organizations:removeMember", { membershipId: M_A }, "admin removes owner");
await expectCall("B", "deny", "mutation", "organizations:updateRole", { membershipId: M_C, role: "owner" }, "admin grants owner");
await expectCall("B", "deny", "mutation", "organizations:remove", { organizationId: ORG }, "admin deletes org");
await expectCall("B", "allow", "mutation", "organizations:rename", { organizationId: ORG, name: "e2e-org-a" }, "admin renames org");
// owner invariants
await expectCall("A", "deny", "mutation", "organizations:updateRole", { membershipId: M_A, role: "admin" }, "last owner self-demotes");
await expectCall("A", "deny", "mutation", "organizations:removeMember", { membershipId: M_A }, "last owner self-removes");
