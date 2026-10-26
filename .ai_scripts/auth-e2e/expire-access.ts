/**
 * Force the access token in a scratch credentials.json to be EXPIRED: same
 * claims, re-signed with the local deployment key, exp in the past — exactly
 * what the backend sees an hour after login. The refresh token is untouched.
 *
 *   CREDS=…/credentials.json KEY_JSON=<env dump with JWT_PRIVATE_KEY> bun expire-access.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { SignJWT, decodeJwt, importPKCS8 } from "../../db/node_modules/jose";

const path = process.env.CREDS!;
const pem = (JSON.parse(readFileSync(process.env.KEY_JSON!, "utf8")) as { environmentVariables: Record<string, string> }).environmentVariables.JWT_PRIVATE_KEY!;
const creds = JSON.parse(readFileSync(path, "utf8")) as { accessToken: string };
const claims = decodeJwt(creds.accessToken);
const now = Math.floor(Date.now() / 1000);
creds.accessToken = await new SignJWT({})
  .setProtectedHeader({ alg: "RS256" })
  .setSubject(claims.sub!).setIssuer(claims.iss!).setAudience(claims.aud as string)
  .setIssuedAt(now - 3700).setExpirationTime(now - 100)
  .sign(await importPKCS8(pem, "RS256"));
writeFileSync(path, JSON.stringify(creds, null, 2), { mode: 0o600 });
console.log(`access token for ${claims.sub} now expired at ${new Date((now - 100) * 1000).toISOString()}`);
