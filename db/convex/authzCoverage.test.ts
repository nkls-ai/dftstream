/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";

// Mechanical authorization coverage.
//
// The failure mode this exists to catch is not a clever bypass — it is the
// ordinary one: somebody adds `export const listSomething = query({...})` to a
// run-child module, forgets the gate, and ships a cross-tenant read. Nothing
// about that diff looks wrong in review.
//
// So: parse every convex module's SOURCE, enumerate the public function
// registrations, and require each one to be present in the registry below with
// an explicit classification. A new or renamed public function fails the suite
// until its author says, in the registry, how it is protected. Functions
// classified as org-gated must additionally name one of the authz helpers in
// their handler body.
//
// This is a static check and it is deliberately shallow: it proves a gate is
// CALLED, not that it is called correctly. The behavioural half of that lives
// in authz.test.ts. Both are needed; neither replaces the other.

const sources = import.meta.glob("./*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

// How a public function is protected. Every registry entry picks exactly one.
const Gate = {
  // Reaches org-owned rows; must call an authz gate helper.
  ORG: "org",
  // No org-owned row to gate on, but must not be anonymous.
  IDENTITY: "identity",
  // Touches only the caller's own identity/session rows, resolved server-side
  // from ctx.auth — there is no id argument to confuse.
  SELF: "self",
  // Takes an id, but every row it can return is the CALLER's own, so there is
  // nothing an attacker gains by passing someone else's id. Requires a reason:
  // this is the classification most easily abused to wave a real gap through.
  SELF_LOOKUP: "self-lookup",
  // Deliberately reachable without credentials. Requires a reason.
  PUBLIC: "public",
  // Known gap that this module is not permitted to fix. Requires a reason.
  KNOWN_GAP: "known-gap",
} as const;

type GateKind = (typeof Gate)[keyof typeof Gate];

type Entry = { gate: GateKind; reason?: string };

// Helpers that constitute "this function is org-gated". Kept as a list rather
// than a regex so adding a gate helper to authz.ts is a deliberate act.
const GATE_HELPERS = [
  "gateRunRead",
  "gateRunWrite",
  "gateRunModify",
  "gateExperimentRead",
  "gateExperimentRowModify",
  "gateArtifactRead",
  "gateArtifactWrite",
  "gatePathwayRead",
  // requireAnyMembership under the active authz policy (upload URLs,
  // migration kicks): membership in some org, no row to hang one off.
  "gateAnyMembership",
  // requireOrgRole(member) on the experiment's org + the caller's appUsers id;
  // the shared gate of every "create a row under an experiment" mutation.
  "authorizeExperimentWrite",
  // "auth on → require an org the caller belongs to" for org-listing queries.
  "resolveOrgScope",
  "requireMembership",
  "requireOrgRole",
  "requireCanModify",
  "requireCanModifyRun",
  "requireAnyMembership",
  "requireBrowserIdentity",
  "orgOfRun",
  "orgOfExperiment",
  "orgOfArtifact",
  "orgOfPathway",
  // queue.ts's shared per-row gate: requireOrgRole(orgOfExperiment, "member"),
  // factored out because every queue write starts from a fetched job row.
  "gateQueuedJobWrite",
] as const;

const IDENTITY_HELPERS = [
  ...GATE_HELPERS,
  "requireIdentity",
  "currentUserId",
  "lookupAppUser",
  // null only for a caller with no identity at all; everything else rethrows.
  "maybeAppUser",
] as const;

const org = (): Entry => ({ gate: Gate.ORG });

const REGISTRY: Record<string, Entry> = {
  // --- run-child tables: every one is runId-scoped ---------------------------
  "events:appendMany": org(),
  "events:listForRun": org(),
  "logs:appendMany": org(),
  "logs:listForRun": org(),
  "metrics:appendMany": org(),
  "metrics:byRunKey": org(),
  "geometries:append": org(),
  "geometries:listForRun": org(),
  "frequencies:setAll": org(),
  "frequencies:getForRun": org(),
  "excitedStates:setAll": org(),
  "excitedStates:listForRun": org(),
  "nmrShields:setAll": org(),
  "nmrShields:listForRun": org(),
  "sysSamples:appendMany": org(),
  "sysSamples:forRun": org(),

  // --- runs -----------------------------------------------------------------
  "runs:create": org(),
  "runs:updateStatus": org(),
  "runs:listByExperiment": org(),
  "runs:listByBatchPaged": org(),
  "runs:batchProgress": org(),
  "runs:get": org(),
  "runs:rename": org(),
  "runs:setNotes": org(),
  "runs:setTags": org(),
  "runs:listChildren": org(),
  "runs:setParent": org(),
  "runs:findByExperimentAndName": org(),
  "runs:listRunning": org(),
  // Re-export of experiments:removeRunNow; the body check follows the alias.
  "runs:remove": org(),

  // --- spool (offline-journal replay guards, P0-11) --------------------------
  // Same gates as the mutations they wrap: createRun ≙ runs:create,
  // append* ≙ the *:appendMany family — plus a spoolMarkers idempotency key.
  "spool:createRun": org(),
  "spool:appendEvents": org(),
  "spool:appendMetrics": org(),
  "spool:appendLogs": org(),
  "spool:appendSysSamples": org(),

  // --- reimport (P0-5 backfill tooling) -------------------------------------
  // Same gates as the runs.ts paths they mirror: listRuns ≙ listByExperiment,
  // findOutput ≙ artifacts:listForRun, apply ≙ runs:updateStatus.
  "reimport:listRuns": org(),
  "reimport:findOutput": org(),
  "reimport:apply": org(),

  // --- artifacts ------------------------------------------------------------
  "artifacts:setAll": org(),
  "artifacts:upsertForRun": org(),
  "artifacts:appendToRun": org(),
  "artifacts:appendChunk": org(),
  "artifacts:remove": org(),
  "artifacts:listForRun": org(),
  "artifacts:getContent": org(),
  "artifacts:cubeIndex": org(),
  "artifacts:getVibModesForRun": org(),
  // These two spend deployment storage before any run row exists to gate on,
  // so they gate on "member of some org" instead (requireAnyMembership).
  "artifacts:generateUploadUrl": org(),
  "artifacts:deleteBlob": org(),

  // --- experiments ----------------------------------------------------------
  "experiments:ensure": org(),
  "experiments:list": org(),
  "experiments:get": org(),
  "experiments:getByName": org(),
  "experiments:listWithSummary": org(),
  "experiments:listBatches": org(),
  "experiments:getBatch": org(),
  "experiments:createBatch": org(),
  "experiments:ensureBatch": org(),
  "experiments:renameBatch": org(),
  "experiments:removeBatch": org(),
  "experiments:rename": org(),
  "experiments:remove": org(),
  "experiments:removeRunNow": org(),

  // --- input-builder templates (P1-1) ---------------------------------------
  "templates:list": org(),
  "templates:create": org(),
  "templates:update": org(),
  "templates:remove": org(),

  // --- pathways -------------------------------------------------------------
  "pathways:list": org(),
  "pathways:get": org(),
  "pathways:create": org(),
  "pathways:rename": org(),
  "pathways:updatePoints": org(),
  "pathways:remove": org(),

  // --- organizations --------------------------------------------------------
  // myOrgs/myRole resolve the caller server-side and return only their own
  // memberships, so there is no org to be a member of yet.
  "organizations:myOrgs": { gate: Gate.SELF },
  "organizations:myRole": {
    gate: Gate.SELF_LOOKUP,
    reason:
      "takes an organizationId but returns only the CALLER's own membership row's role, or null. Passing a stranger's org id yields null — the same answer a non-member gets — so it discloses nothing about that org.",
  },
  "organizations:members": org(),
  "organizations:create": { gate: Gate.IDENTITY },
  "organizations:addMember": org(),
  "organizations:listInvites": org(),
  "organizations:revokeInvite": org(),
  "organizations:updateRole": org(),
  "organizations:removeMember": org(),
  "organizations:rename": org(),
  "organizations:remove": org(),

  // --- identity / CLI sessions ----------------------------------------------
  "users:ensureSelf": { gate: Gate.SELF },
  "users:me": { gate: Gate.SELF },
  "cliLinks:approve": org(),
  "cliLinks:listMine": { gate: Gate.SELF },
  // Own-session-or-org-admin; requireOrgRole covers the admin branch.
  "cliLinks:revoke": org(),

  // --- machine tokens (P0-2 non-interactive auth) ----------------------------
  // Minting and revoking are browser-only admin mutations (requireBrowserIdentity
  // + requireOrgRole admin); list is admin-gated and never returns the digest.
  // The exchange itself is the /cli/token/exchange HTTP route below.
  "machineTokens:create": org(),
  "machineTokens:list": org(),
  "machineTokens:revoke": org(),

  // --- scheduler queue (P1-2 status/cancel visibility) -----------------------
  // register/updateStates are the wrapper's reporting path (member+ via the
  // run-write bar); requestCancel only flips a flag the login-node watcher
  // acts on; listActive mirrors runs:listRunning's org scoping.
  "queue:register": org(),
  "queue:updateStates": org(),
  "queue:requestCancel": org(),
  "queue:listByExperiment": org(),
  "queue:listActive": org(),

  // --- deliberately public --------------------------------------------------
  "meta:version": {
    gate: Gate.PUBLIC,
    reason:
      "wrapper/backend version handshake, called before the wrapper has a token; reads no data",
  },

  // --- migration entry points -----------------------------------------------
  // Kicked from app bootstrap. They own no org rows, but each schedules
  // deployment-wide work, so membership (not merely a session) is the bar.
  "migrations:startIfNeeded": { gate: Gate.IDENTITY },
  "migrations:startBatchProgressBackfillIfNeeded": { gate: Gate.IDENTITY },
  "migrations:startExperimentProgressBackfillIfNeeded": { gate: Gate.IDENTITY },
};

// HTTP routes are a separate public surface with no argument validators and no
// ctx.auth — each one has to justify itself the same way.
const HTTP_ROUTES: Record<string, string> = {
  "/cli/link/start":
    "unauthenticated by construction (the CLI has no credential yet). Mints only an unguessable UUID code bound to nothing; rows expire (LINK_TTL_MS) and are swept.",
  "/cli/link/poll":
    "unauthenticated; the UUID code is the only secret. Single-use — an approved link flips to consumed and a replay gets 410.",
  "/cli/link/refresh":
    "unauthenticated; the refresh token (two UUIDs) is the credential. Validated against revokedAt/refreshExpiresAt and a live membership on every call.",
  "/cli/token/exchange":
    "unauthenticated; the machine token (ost_ + 256 random bits, stored only as a sha256 digest) is the credential. Validated against revokedAt and the minting admin's live membership on every exchange, throttled per token (slow_down), and it mints only the same short-lived org-scoped access token the browser-link poll mints.",
  "/api/artifact":
    "authenticated artifact-body download: validates the caller's JWT (401 without one when auth is on) and re-runs the artifact→run→org membership gate (artifacts._bodyMeta) on every request. Replaces non-expiring signed storage URLs. The OPTIONS registration on the same path is the CORS preflight and serves no data.",
};

// --- source parsing ---------------------------------------------------------

const REGISTRATION =
  /^export const (\w+) = (query|mutation|action)\(/;
const REEXPORT = /^export \{\s*(\w+)\s+as\s+(\w+)\s*\}\s*from\s*"\.\/(\w+)"/;

type Found = {
  key: string;
  module: string;
  name: string;
  // The module + name the body actually lives in (differs for re-exports).
  bodyModule: string;
  bodyName: string;
};

function moduleName(path: string): string {
  return path.replace(/^\.\//, "").replace(/\.ts$/, "");
}

// Modules that register no public functions and are not expected to.
const NON_FUNCTION_MODULES = new Set([
  "schema",
  "auth.config",
  "authz",
  // auth.ts re-exports convex-auth's own generated handlers (signIn/signOut/
  // store/isAuthenticated). They are the auth provider's surface, not ours.
  "auth",
  // http.ts registers httpActions through the router, checked separately.
  "http",
]);

function sourceModules(): { name: string; src: string }[] {
  return Object.entries(sources)
    .filter(([path]) => !path.endsWith(".test.ts"))
    .map(([path, src]) => ({ name: moduleName(path), src }))
    .filter((m) => !NON_FUNCTION_MODULES.has(m.name));
}

function discover(): Found[] {
  const found: Found[] = [];
  for (const { name: mod, src } of sourceModules()) {
    for (const line of src.split("\n")) {
      const reg = REGISTRATION.exec(line);
      if (reg) {
        const name = reg[1]!;
        found.push({
          key: `${mod}:${name}`,
          module: mod,
          name,
          bodyModule: mod,
          bodyName: name,
        });
        continue;
      }
      const re = REEXPORT.exec(line);
      if (re) {
        const [, srcName, alias, srcMod] = re;
        found.push({
          key: `${mod}:${alias}`,
          module: mod,
          name: alias!,
          bodyModule: srcMod!,
          bodyName: srcName!,
        });
      }
    }
  }
  return found;
}

// handlerBody returns the source of one registration: from its `export const`
// line to the next top-level `export`, which is where the next function starts.
function handlerBody(mod: string, name: string): string {
  const src = sources[`./${mod}.ts`];
  if (src === undefined) throw new Error(`no source for module ${mod}`);
  const lines = src.split("\n");
  const start = lines.findIndex((l) =>
    new RegExp(`^export const ${name} = (query|mutation|action)\\(`).test(l),
  );
  if (start === -1) throw new Error(`no registration for ${mod}:${name}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^export /.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

// --- the tests --------------------------------------------------------------

describe("authorization coverage", () => {
  const found = discover();

  test("every public function is classified in the registry", () => {
    const undeclared = found
      .map((f) => f.key)
      .filter((key) => !(key in REGISTRY))
      .sort();
    // If this fails you added or renamed a public Convex function. Decide how
    // it is protected, then add it to REGISTRY above — do not delete this test.
    expect(undeclared).toEqual([]);
  });

  test("the registry has no entries for functions that no longer exist", () => {
    const live = new Set(found.map((f) => f.key));
    const stale = Object.keys(REGISTRY)
      .filter((key) => !live.has(key))
      .sort();
    expect(stale).toEqual([]);
  });

  test("org-gated functions call an authz gate helper", () => {
    const ungated: string[] = [];
    for (const f of found) {
      if (REGISTRY[f.key]?.gate !== Gate.ORG) continue;
      const body = handlerBody(f.bodyModule, f.bodyName);
      if (!GATE_HELPERS.some((h) => body.includes(h))) ungated.push(f.key);
    }
    expect(ungated.sort()).toEqual([]);
  });

  test("self-scoped functions resolve identity server-side", () => {
    const missing: string[] = [];
    for (const f of found) {
      const gate = REGISTRY[f.key]?.gate;
      if (gate !== Gate.SELF && gate !== Gate.SELF_LOOKUP) continue;
      const body = handlerBody(f.bodyModule, f.bodyName);
      if (!IDENTITY_HELPERS.some((h) => body.includes(h))) missing.push(f.key);
    }
    expect(missing.sort()).toEqual([]);
  });

  test("identity-gated functions require an identity", () => {
    const missing: string[] = [];
    for (const f of found) {
      if (REGISTRY[f.key]?.gate !== Gate.IDENTITY) continue;
      const body = handlerBody(f.bodyModule, f.bodyName);
      if (!IDENTITY_HELPERS.some((h) => body.includes(h))) missing.push(f.key);
    }
    expect(missing.sort()).toEqual([]);
  });

  test("no self-scoped function takes an id argument it could be tricked with", () => {
    // A SELF classification is only honest while the function has nothing to
    // confuse: the moment one grows an `v.id(...)` argument it is reachable
    // with someone else's row and must be reclassified.
    const suspect: string[] = [];
    for (const f of found) {
      if (REGISTRY[f.key]?.gate !== Gate.SELF) continue;
      const body = handlerBody(f.bodyModule, f.bodyName);
      const args = /args:\s*\{([\s\S]*?)\},\s*\n\s*handler/.exec(body)?.[1];
      if (args && args.includes("v.id(")) suspect.push(f.key);
    }
    expect(suspect.sort()).toEqual([]);
  });

  test("public, known-gap and self-lookup classifications carry a written reason", () => {
    const unjustified = Object.entries(REGISTRY)
      .filter(
        ([, e]) =>
          (e.gate === Gate.PUBLIC ||
            e.gate === Gate.KNOWN_GAP ||
            e.gate === Gate.SELF_LOOKUP) &&
          (e.reason ?? "").length < 40,
      )
      .map(([key]) => key)
      .sort();
    expect(unjustified).toEqual([]);
  });

  test("every HTTP route is enumerated with a justification", () => {
    const http = sources["./http.ts"];
    expect(http).toBeDefined();
    // De-duplicated: one path may carry several method registrations (the
    // artifact route answers GET and its CORS-preflight OPTIONS); the
    // justification covers the path, methods and all.
    const paths = [
      ...new Set(
        [...http!.matchAll(/^\s*path: "([^"]+)"/gm)].map((m) => m[1]!),
      ),
    ];
    expect(paths.sort()).toEqual(Object.keys(HTTP_ROUTES).sort());
    for (const [path, reason] of Object.entries(HTTP_ROUTES)) {
      expect(reason.length, `${path} needs a real justification`).toBeGreaterThan(40);
    }
  });

  test("no module registers a public function outside the registry's files", () => {
    // Guards against a new convex/*.ts appearing that the glob picks up but
    // nobody classified — the "every public function is classified" test above
    // already covers it, but this makes the module list itself explicit.
    const modulesWithFunctions = new Set(found.map((f) => f.module));
    const registryModules = new Set(
      Object.keys(REGISTRY).map((k) => k.split(":")[0]!),
    );
    expect([...modulesWithFunctions].sort()).toEqual(
      [...registryModules].sort(),
    );
  });
});
