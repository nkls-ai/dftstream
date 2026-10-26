import { query } from "./_generated/server";
import { authEnabled } from "./authz";

// Wrapper ↔ backend compatibility handshake.
//
// The wrapper and the Convex functions ship in the same repo but are deployed
// separately: a chemist can upgrade the `dftstream` binary without pushing
// functions (or vice versa). Before this query existed, that mismatch surfaced
// as opaque "Convex function X returned HTTP 400" failures halfway through a
// job. `meta:version` gives the wrapper one cheap, unauthenticated call it can
// make at startup to decide whether the pair is compatible and, if not, to name
// the exact command that fixes it.
//
// API_VERSION is a single integer that is bumped whenever the wire contract
// between wrapper and backend changes in a way an older wrapper cannot satisfy
// (a new required mutation argument, a renamed function, a dropped table). It
// is NOT the product version — `dftstream --version` stays independent.
//
// Support policy: a backend at API_VERSION N accepts wrappers at N and N-1.
// That one-version window is what lets an operator upgrade a cluster of
// submit hosts and the backend on different days.
export const API_VERSION = 1;

// The oldest wrapper API version this deployment still serves. Derived from the
// policy above rather than hand-maintained so the two can never drift.
export const MIN_WRAPPER_API_VERSION = API_VERSION - 1;

// Optional capability names the wrapper (or UI) may probe for when a feature is
// additive and does not warrant an API_VERSION bump. Additive only: never
// remove a name here without bumping API_VERSION, since callers treat a missing
// name as "backend cannot do this".
export const FEATURES = [
  "organizations", // org-scoped experiments/runs (authz.ts)
  "artifactBlobs", // artifacts uploaded to file storage, not chunked rows
  "hessHistory", // per-hessian frequency sets (frequencies.hessIdx)
  "runLineage", // parentRunId / parentEdgeKind on runs
  "propertyJson", // wrapper ingests <base>.property.json and reconciles it
  "spool", // idempotency-guarded replay of offline journals (spool.ts)
] as const;

// version reports the deployed API contract. Deliberately public and
// unauthenticated: the wrapper calls it before it has proven its token, and a
// stale-credentials 401 must not masquerade as a version mismatch. It reads no
// data and reveals nothing beyond what the deployed code already is.
export const version = query({
  args: {},
  handler: async () => ({
    apiVersion: API_VERSION,
    minWrapperApiVersion: MIN_WRAPPER_API_VERSION,
    features: [...FEATURES],
    // Whether this deployment enforces org isolation, so a client can detect a
    // backend running with enforcement off before it sends anything sensitive.
    // Reveals only deployment configuration, not data. Note authEnabled()
    // THROWS on a malformed DFTSTREAM_AUTH_REQUIRED — deliberately loud even
    // on this public surface: a misconfigured auth flag should break the
    // handshake, not hide behind it.
    authRequired: authEnabled(),
  }),
});
