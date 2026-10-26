import { httpRouter, type FunctionReturnType } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { SignJWT, importPKCS8 } from "jose";
import { auth } from "./auth";
import { authEnabled, cliSubject } from "./authz";
import { CONVEX_APPLICATION_ID } from "./lib/authIssuers";

const http = httpRouter();

// convex-auth's sign-in / token / JWKS routes (no-ops at runtime until the
// JWT_PRIVATE_KEY/JWKS/SITE_URL env vars are configured). Clerk deployments
// don't exercise these.
auth.addHttpRoutes(http);

// --- DFTStream CLI browser-link ------------------------------------------
//
// `dftstream login` (browser-link mode) drives these, RFC 8628-style. Two
// values per handshake, minted here:
//
//   deviceCode — high-entropy secret returned ONLY in the /cli/link/start
//                response body to the CLI. Never in any URL. Polling and
//                token issuance require it.
//   userCode   — short human-verification code. It rides the browser verify
//                URL and the approval screen, so it is treated as public: it
//                can target an approval (cliLinks.approve) and nothing else.
//
// The minted access token is a JWT signed with the SAME deployment key
// convex-auth publishes in its JWKS, with issuer = CONVEX_SITE_URL and
// aud = "convex" — so Convex validates it exactly like any other token. Its
// subject is `cli|<appUsersId>|<orgId>`, which authz maps back to the human's
// identity row AND to the single org the human approved (see
// authz.parseCliSubject / requireMembership). This works regardless of whether
// the human logged into the UI via convex-auth or Clerk.
//
// The access token is deliberately short-lived and carries no revocation state
// of its own; revocation lives on the cliLinks row the refresh token names, so
// the blast radius of a leaked access token is bounded by ACCESS_TTL. Anything
// longer would have to be a lookup on every request.
//
// Refresh tokens are stored hashed and rotate on every redemption: the
// database only ever holds sha256 digests (a DB leak cannot replay a
// session), and a rotated-out token that resurfaces later revokes the whole
// link (someone else spent it first — see cliLinks.redeemRefresh).

const ACCESS_TTL = "1h";

// Seconds the CLI should wait between polls (RFC 8628 `interval`). The server
// floor is cliLinks.MIN_POLL_INTERVAL_MS; keeping the advertised interval
// above it leaves headroom for clock skew.
const POLL_INTERVAL_S = 3;

// User-code alphabet: uppercase consonants + digits, minus lookalikes
// (0/O, 1/I/L) and vowels (no accidental words). 8 chars ≈ 39 bits — far more
// than RFC 8628 asks of a user code, and cliLinks.approve refuses ambiguous
// matches on the off chance of a live collision.
const USER_CODE_ALPHABET = "BCDFGHJKMNPQRSTVWXZ23456789";
const USER_CODE_LENGTH = 8;

function generateUserCode(): string {
  const bytes = new Uint8Array(USER_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    if (i === USER_CODE_LENGTH / 2) out += "-";
    out += USER_CODE_ALPHABET[bytes[i]! % USER_CODE_ALPHABET.length];
  }
  return out;
}

// A fresh opaque bearer secret (device code / refresh token): two UUIDs,
// ~244 bits of randomness.
function generateSecret(): string {
  return crypto.randomUUID() + crypto.randomUUID();
}

// sha256 hex digest. Runs here (httpAction, which has crypto.subtle) so the
// mutations only ever see and store digests — plaintext secrets exist solely
// in HTTP response bodies.
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// The deployment key + issuer every CLI access token is signed with.
type Signer = { key: CryptoKey; issuer: string };

const SIGNING_NOT_CONFIGURED =
  "CLI token signing is not configured on this deployment " +
  "(set JWT_PRIVATE_KEY and CONVEX_SITE_URL, see docs/auth.md)";

// Load the signing key BEFORE any state change. Token-issuing routes used to
// consume the handshake (poll), rotate the refresh token (refresh) or stamp
// the throttle (exchange) and only then discover a missing or malformed key:
// the 500 that followed lost the freshly rotated refresh token for good (the
// next refresh after the grace window then looked like theft and revoked the
// session) and burned the login handshake. Now a misconfigured deployment
// answers 503 up front and nothing is spent.
async function loadSigner(): Promise<Signer | null> {
  const pem = process.env.JWT_PRIVATE_KEY;
  const issuer = process.env.CONVEX_SITE_URL;
  if (!pem || !issuer) return null;
  try {
    return { key: await importPKCS8(pem, "RS256"), issuer };
  } catch (err) {
    // A malformed PEM is an operator error; the client only needs the 503.
    console.error("JWT_PRIVATE_KEY could not be imported", err);
    return null;
  }
}

function signingNotConfigured(): Response {
  return json({ error: SIGNING_NOT_CONFIGURED }, 503);
}

async function mintAccessToken(
  signer: Signer,
  appUserId: string,
  organizationId: string,
): Promise<string> {
  return await new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setSubject(cliSubject(appUserId, organizationId))
    .setIssuer(signer.issuer)
    .setAudience(CONVEX_APPLICATION_ID)
    .setIssuedAt()
    .setExpirationTime(ACCESS_TTL)
    .sign(signer.key);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A request-body field that was read, or the 400 to send back instead. */
type FieldRead = { ok: true; value: string } | { ok: false; response: Response };

/**
 * readStringField reads one required, non-empty string field from a JSON
 * request body. A malformed body, a non-object body, or a missing / empty /
 * non-string field is the CLIENT's error and gets a 400 naming the field —
 * never the opaque 500 an uncaught `req.json()` throw used to produce, and
 * never a non-string smuggled on into a mutation argument by a bare cast.
 */
async function readStringField(req: Request, key: string): Promise<FieldRead> {
  let body: unknown;
  try {
    body = await req.json();
  } catch (err) {
    // The parse error only restates that the body is not JSON; the 400 below
    // is the whole answer, and the detail goes to the log for an operator.
    console.warn(`${new URL(req.url).pathname}: malformed JSON body`, err);
    return { ok: false, response: json({ error: `${key} required` }, 400) };
  }
  const value =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)[key]
      : undefined;
  if (typeof value !== "string" || value === "") {
    return { ok: false, response: json({ error: `${key} required` }, 400) };
  }
  return { ok: true, value };
}

http.route({
  path: "/cli/link/start",
  method: "POST",
  handler: httpAction(async (ctx, _req) => {
    // Fail the login at its first step, not after the human approved it.
    if (!(await loadSigner())) return signingNotConfigured();
    const deviceCode = generateSecret();
    const userCode = generateUserCode();
    const linkId = await ctx.runMutation(internal.cliLinks.start, {
      code: deviceCode,
      userCode,
    });
    // null = the pending-handshake cap; someone is spraying this endpoint.
    if (linkId === null) {
      return json({ error: "too many pending login attempts" }, 429);
    }
    // Only the userCode goes in the verify URL the CLI prints; the deviceCode
    // stays between this response body and /cli/link/poll.
    return json({
      deviceCode,
      userCode,
      verifyPath: `/cli-link?userCode=${encodeURIComponent(userCode)}`,
      interval: POLL_INTERVAL_S,
    });
  }),
});

http.route({
  path: "/cli/link/poll",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const field = await readStringField(req, "deviceCode");
    if (!field.ok) return field.response;
    const deviceCode = field.value;
    const signer = await loadSigner();
    if (!signer) return signingNotConfigured();
    const poll = await ctx.runMutation(internal.cliLinks.registerPoll, {
      code: deviceCode,
    });
    switch (poll.outcome) {
      case "unknown":
        return json({ error: "unknown code" }, 404);
      case "slow_down":
        // RFC 8628: the client must back off. Deliberately does not advance
        // the throttle window, so a compliant retry succeeds.
        return json({ error: "slow_down", interval: POLL_INTERVAL_S }, 429);
      case "expired":
        return json({ error: "expired" }, 410);
      case "consumed":
        return json({ error: "already used" }, 410);
      case "pending":
        return json({ status: "pending" });
      case "approved":
        break;
    }

    const refreshToken = generateSecret();
    const bound = await ctx.runMutation(internal.cliLinks.consume, {
      code: deviceCode,
      refreshToken: await sha256Hex(refreshToken),
    });
    if (!bound?.appUserId || !bound.organizationId) {
      return json({ error: "link not bound" }, 409);
    }
    const accessToken = await mintAccessToken(
      signer,
      bound.appUserId,
      bound.organizationId,
    );
    return json({
      status: "approved",
      accessToken,
      refreshToken,
      organizationId: bound.organizationId,
      organizationName: bound.organizationName,
      organizationSlug: bound.organizationSlug,
    });
  }),
});

http.route({
  path: "/cli/link/refresh",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const field = await readStringField(req, "refreshToken");
    if (!field.ok) return field.response;
    const refreshToken = field.value;
    const signer = await loadSigner();
    if (!signer) return signingNotConfigured();
    const nextToken = generateSecret();
    // redeemRefresh returns null for every rejection (unknown / revoked /
    // expired / replayed-after-rotation / no longer a member); the response
    // deliberately does not say which, so a caller with a bad token learns
    // nothing from the difference.
    const bound = await ctx.runMutation(internal.cliLinks.redeemRefresh, {
      refreshToken: await sha256Hex(refreshToken),
      nextRefreshToken: await sha256Hex(nextToken),
    });
    if (!bound) return json({ error: "invalid refresh token" }, 401);
    const accessToken = await mintAccessToken(
      signer,
      bound.appUserId,
      bound.organizationId,
    );
    // rotated=false is the concurrent-refresh grace path: the presented token
    // was just superseded by a parallel refresh, so this caller gets an access
    // token but must keep using whatever refresh token is already persisted
    // (on a shared host, the winner's rotation is already on disk).
    return bound.rotated
      ? json({ accessToken, refreshToken: nextToken })
      : json({ accessToken });
  }),
});

// --- authenticated artifact bodies ----------------------------------------
//
// GET /api/artifact?id=<artifactId> streams a storage-backed artifact body.
// This is the ONLY way a client reads a blob: queries stopped returning
// signed storage URLs (they never expire and storage has no per-org ACL, so a
// recorded URL out-lived the recorder's membership — docs/auth.md).
// Every request authenticates via the caller's own JWT (Authorization:
// Bearer, the same token Convex queries use; ctx.auth validates it) and
// re-runs the same membership gate as artifacts.getContent, in
// artifacts._bodyMeta. When the deployment runs with auth disabled
// (single-user local mode) the gate no-ops, exactly like every query gate.
//
// CORS: the UI is served from a different origin than the Convex site, and
// the Authorization header forces a preflight, so OPTIONS is answered below.
// `Access-Control-Allow-Origin: *` is safe here — authorization rides the
// bearer header (never cookies), so an allowed origin gains nothing without
// also holding a valid token.

const ARTIFACT_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

function artifactError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", ...ARTIFACT_CORS_HEADERS },
  });
}

http.route({
  path: "/api/artifact",
  method: "OPTIONS",
  handler: httpAction(async (_ctx, _req) => {
    return new Response(null, { status: 204, headers: ARTIFACT_CORS_HEADERS });
  }),
});

http.route({
  path: "/api/artifact",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return artifactError("id query parameter required", 400);
    // 401 before 403: an unauthenticated caller learns only that the route
    // wants credentials, not whether the artifact exists.
    if (authEnabled() && (await ctx.auth.getUserIdentity()) === null) {
      return artifactError("authentication required", 401);
    }
    let meta: FunctionReturnType<typeof internal.artifacts._bodyMeta>;
    try {
      // _bodyMeta runs the artifact→run→org membership gate with the caller's
      // identity (auth propagates through runQuery).
      meta = await ctx.runQuery(internal.artifacts._bodyMeta, {
        artifactId: id,
      });
    } catch (err) {
      // The CLIENT learns only "403": distinguishing "not a member" sub-cases
      // would feed enumeration. The operator still needs the real cause — a
      // misconfigured deployment or a db failure lands here too, and would
      // otherwise be indistinguishable from an ordinary denial.
      console.error(`/api/artifact: _bodyMeta refused artifact ${id}`, err);
      return artifactError("not authorized for this artifact", 403);
    }
    if (!meta) return artifactError("artifact body not found", 404);
    const blob = await ctx.storage.get(meta.storageId);
    if (!blob) return artifactError("artifact body not found", 404);
    return new Response(blob, {
      status: 200,
      headers: {
        // The bytes are whatever the wrapper stored (possibly a zstd frame);
        // the client decodes per the `encoding` field from getContent, never
        // by sniffing — so the wire type stays opaque.
        "Content-Type": "application/octet-stream",
        "Content-Length": String(blob.size),
        // Bodies are immutable per artifactId but access is membership-
        // gated; never let a shared cache serve one without the gate.
        "Cache-Control": "private, no-store",
        ...ARTIFACT_CORS_HEADERS,
      },
    });
  }),
});

// --- machine-token exchange (non-interactive auth) -------------------------
//
// POST /cli/token/exchange — body {"token": "ost_…"} — trades a long-lived
// org-scoped machine token (minted by an org admin in the settings UI, see
// machineTokens.ts) for the SAME short-lived `cli|` access token the
// browser-link poll mints. This is how a SLURM batch script authenticates:
// no browser, no stored credentials — the wrapper reads DFTSTREAM_TOKEN
// from the environment and re-exchanges on startup and on any 401.
//
// Unlike the browser-link flow there is no refresh chain: the machine token
// itself is the long-lived credential, so revocation (machineTokens.revoke)
// bites at the next exchange and a revoked token's outstanding access token
// dies within ACCESS_TTL. The secret is hashed here (this runtime has
// crypto.subtle) so the mutation only ever sees the digest — same division
// of labor as /cli/link/poll and /cli/link/refresh.
http.route({
  path: "/cli/token/exchange",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const field = await readStringField(req, "token");
    if (!field.ok) return field.response;
    const token = field.value;
    const signer = await loadSigner();
    if (!signer) return signingNotConfigured();
    const outcome = await ctx.runMutation(internal.machineTokens.redeemExchange, {
      digest: await sha256Hex(token),
    });
    switch (outcome.outcome) {
      case "unknown":
        // Uniform for "no such token" and "creator lost org membership": a
        // caller with a bad token learns nothing from the difference.
        return json({ error: "invalid token" }, 401);
      case "revoked":
        // Distinguishable on purpose — the operator deliberately killed it,
        // and the holder's fix is different (mint a new one, don't retry).
        return json({ error: "token revoked" }, 410);
      case "slow_down":
        // Per-token exchange floor (mirrors the RFC 8628 slow_down contract
        // of /cli/link/poll). The refused attempt does not advance the
        // window, so a backed-off retry succeeds.
        return json({ error: "slow_down" }, 429);
      case "ok":
        break;
    }
    const accessToken = await mintAccessToken(
      signer,
      outcome.appUserId,
      outcome.organizationId,
    );
    return json({ accessToken, organizationId: outcome.organizationId });
  }),
});

export default http;
