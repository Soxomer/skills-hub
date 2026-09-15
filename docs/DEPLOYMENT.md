# Hosted Skill Manager

The browser runs on Vercel; Fastify and PostgreSQL run on Railway. Cloudflare
provides the domain DNS. The local `ahm` runner remains on each workstation.
Cloudflare Access / Zero Trust is not required and has not been activated.

## Vercel

- Domain: `skill-manager.omarjetti.dev`.
- Build from the repository root with `vercel.json`.
- `/api` (including `/api/auth`), `/runner`, and `/health` proxy to Railway.
- Leave `VITE_AHM_API_BASE_URL` unset for same-origin requests and cookies.
- Keep preview deployment protection enabled; never put secrets in browser build variables.

## Railway

- Repository: `Soxomer/skills-hub`, branch `main`, root `/`.
- Builder: Dockerfile, path `Dockerfile`; no custom build command.
- Start: `npm run start --workspace @ahm/control-plane` (includes migrations).
- Health check: `/health`; generated domain target port: `8080`.
- PostgreSQL uses a persistent volume and Railway's private network.
- Configure service settings in the dashboard, not legacy `railway.json`.

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` |
| `PORT` | `8080` |
| `AHM_AUTH_MODE` | `better-auth` |
| `PUBLIC_SERVER_URL` | `https://skill-manager.omarjetti.dev` |
| `BETTER_AUTH_SECRET` | Generated session signing secret |
| `AHM_OWNER_PASSWORD_HASH` | Initial Better Auth scrypt password hash |
| `AHM_OWNER_EMAIL` | Owner sign-in email |

## Better Auth

Better Auth runs inside the Railway backend, using dedicated `auth_*` tables in
the existing PostgreSQL database. It provides email/password sign-in, secure
HttpOnly cookies, 24-hour database sessions, sign-out, and database-backed
sign-in rate limiting. Public sign-up is disabled; only the configured owner
can access the control-plane API. No third-party login subscription is required.

Generate the initial credentials into a private file outside the repository:

```sh
node scripts/create-hosted-password.mjs /private/path/skill-manager-login.json
```

The file contains `password`, `ownerPasswordHash`, and `authSecret`. Store the
password in your password manager. Set `ownerPasswordHash` as
`AHM_OWNER_PASSWORD_HASH` and `authSecret` as `BETTER_AUTH_SECRET` in Railway.
Restrict access to the private file using your operating system. It must never
be committed, included in builds, or put in browser environment variables.

Sign in with the configured owner email and the generated password. Better Auth
stores a scrypt password hash; the browser uses a secure HttpOnly session cookie
and never stores the password in localStorage or sessionStorage. Signing out
revokes the server session. Password reset emails are not configured; use Better
Auth's authenticated change-password endpoint or an administrator-managed reset.

Startup seeds `auth_owner` plus `org_private` / `user_owner` once. Restarts never
reset an existing password or restore a removed organization membership. The
bootstrap hash is used only when the owner is first created. Changing that
variable later is not a password reset. Rotate the session signing secret to
invalidate signed session cookies if necessary.

The API resolves Better Auth sessions on every browser request, ignores
client-supplied actor headers, and requires the configured Origin for mutations.
Direct Railway requests cannot bypass authentication. Runner routes retain their
separate bearer credentials; enrollment requires an expiring single-use code.

## Cloudflare DNS

Point `skill-manager` to Vercel's assigned DNS target. No Access application,
team URL, audience tag, or paid Cloudflare add-on is needed. Keep HTTPS certificate
verification enabled. Domain renewal and Vercel/Railway billing are separate.

## Verification

Run `npm run check` before deployment, then verify:

- Public UI shows an email/password sign-in form when signed out.
- Wrong credentials, expired sessions, and unsigned direct Railway API requests return 401.
- Public registration is disabled and cross-origin mutations return 403.
- Signed-in requests can list projects; sign-out revokes the session.
- `/health` returns 200 and `/runner/v1/jobs/claim` without credentials returns 401.
- Connect a local runner using a generated enrollment command and verify inventory.
