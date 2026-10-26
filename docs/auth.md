# Multi-user auth

Auth is off by default, and a single-user install needs none of this. Turn it
on when a backend is shared beyond a trusted network. With auth on, one backend
holds many organizations, each user has a role in each organization they belong
to, and nobody sees another organization's data.

## Roles

| Role | Can |
| --- | --- |
| viewer | read everything in the organization |
| member | create experiments and runs; edit and delete their own |
| admin | edit and delete anything, manage members and machine tokens, rename the organization |
| owner | everything, plus grant the owner role and delete the organization |

An organization always keeps at least one owner, and only owners can change or
remove an owner.

## Turning it on

1. Set up a sign-in provider on the backend. Pick one:
   - Convex Auth (email and password, self-hosted):
     `cd db && bunx @convex-dev/auth --web-server-url <ui-url>`. This sets
     `JWT_PRIVATE_KEY`, `JWKS` and `SITE_URL` on the deployment.
   - Clerk: set `CLERK_JWT_ISSUER_DOMAIN` on the deployment to your Clerk
     issuer domain.

   `JWT_PRIVATE_KEY` is needed with either provider, because it also signs the
   tokens behind `dftstream login`.
2. Start the UI with the matching sign-in screen:
   `dftstream ui -auth-provider convex`, or
   `dftstream ui -auth-provider clerk -clerk-publishable-key pk_...`.
3. Sign in, create an organization, and claim the experiments that existed
   before auth (they belong to no organization and stay hidden until claimed):

   ```bash
   cd db && bunx convex run organizations:importUnassignedNow '{"organizationId":"<id>"}'
   ```

4. Set `DFTSTREAM_AUTH_REQUIRED=1` on the deployment. Values other than `1`,
   `true`, `0`, `false` or empty are rejected, so a typo cannot quietly leave
   auth off.
5. Check it: a second account without membership sees nothing, and
   `dftstream login` followed by `dftstream run` writes into the chosen
   organization.

If the UI and the backend disagree (the backend requires sign-in but the UI has
no provider, or the other way round), the UI shows a banner.

`convex deploy` fails if `CLERK_JWT_ISSUER_DOMAIN` is unset, even without
Clerk. Set it to an empty string in that case:
`bunx convex env set CLERK_JWT_ISSUER_DOMAIN ""`. `dftstream-db` does this for
the local backend.

## The CLI

`dftstream login` prints a link. Open it while signed in, pick the organization
and approve. The CLI then holds a token for that one organization:

- access tokens last one hour and refresh for up to 30 days;
- removing someone from an organization ends their CLI session at the next
  refresh;
- users and admins can revoke sessions in the UI;
- a CLI token cannot manage members or create new credentials.

Credentials are stored in `~/.config/dftstream/credentials.json` with mode 600.

## Machine tokens

Batch jobs cannot open a browser. An admin creates a machine token under
Settings → Machine tokens and the job sets it:

```bash
export DFTSTREAM_TOKEN=ost_...
```

`DFTSTREAM_TOKEN` takes precedence over a stored login. A machine token
belongs to one organization, can be shared by every task of a job array, and is
shown only once. The backend stores only its hash. Revoking it in the UI stops
new jobs at once and running ones within the hour. When its creator leaves the
organization, the token stops working.

To end every session and token on a deployment at once, rotate `JWT_PRIVATE_KEY`
and `JWKS`.

## Security model

- Every public backend function checks membership and role, and a test fails
  the build when a new function is added without a classified check
  (`db/convex/authzCoverage.test.ts`).
- An ID from another organization is not a key: every row is traced back to its
  organization before access.
- Stored files are only served through `/api/artifact`, which checks
  membership on each request. No query returns a storage URL.
- Refresh tokens and machine tokens are stored as hashes. A refresh token is
  replaced on every use, and reuse of an old one revokes the session.
- Email invitations never attach a membership to an unverified account without
  an admin confirming it.
- Per-artifact, per-run and per-organization storage quotas are enforced on the
  backend (`DFTSTREAM_MAX_ARTIFACT_BYTES`, `DFTSTREAM_MAX_RUN_ARTIFACTS`,
  `DFTSTREAM_ORG_STORAGE_QUOTA_BYTES`).

Known limits: anyone may create organizations, and a CLI login link can be
phished like any device-code login (the window is 10 minutes and the approval
screen names the organization).

## Adding a sign-in provider

Each layer has one interface.

- Backend: implement `IdentityProvider` in
  `db/convex/lib/identityProviders.ts` and register its issuer in
  `db/convex/lib/authIssuers.ts`, which also builds `auth.config.ts`.
- UI: implement `AuthAdapter` in `ui/src/auth/adapters/<name>.tsx`, add the
  kind to `ui/src/auth/providerKind.ts` and register it in
  `ui/src/auth/registry.ts`. Provider SDKs may only be imported from
  `ui/src/auth/adapters/`.
- CLI: implement `TokenSource` in `wrapper/internal/auth/` and add it to
  `auth.Resolve`. The order today is `DFTSTREAM_TOKEN`, then the stored login,
  then none.
