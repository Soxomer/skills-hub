# Hosted Skill Manager

The browser is hosted by the Vercel `skill-manager` project. The Fastify control
plane and PostgreSQL are hosted by the Railway `skill-manager` project. The
local `ahm` runner remains on each workstation.

## Vercel

- Domain: `skill-manager.omarjetti.dev`.
- Build from the repository root with the settings in `vercel.json`.
- `/api`, `/runner`, and `/health` proxy to the Railway service.
- Leave `VITE_AHM_API_BASE_URL` unset so the browser uses the same origin.
- Keep preview deployment protection enabled. Deployment secrets belong in
  provider settings, never in browser build variables.

## Railway

- Repository: `Soxomer/skills-hub`, branch `main`, root directory `/`.
- Builder: Dockerfile, path `Dockerfile`; no custom build command.
- Start: the Docker image command (`npm run start --workspace @ahm/control-plane`).
- Health check: `/health`. Set the generated domain's target port to `8080`.
- PostgreSQL uses a persistent volume and Railway's private network.
- Run migrations before starting the server (the existing start script does this).
- New Railway services no longer accept legacy `railway.json` configuration;
  these service settings are configured in the Railway dashboard.

Set these backend variables:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` |
| `PORT` | `8080` |
| `AHM_AUTH_MODE` | `cloudflare` |
| `PUBLIC_SERVER_URL` | `https://skill-manager.omarjetti.dev` |
| `CF_ACCESS_TEAM_URL` | The HTTPS team origin created in Cloudflare Access |
| `CF_ACCESS_AUD` | The browser Access application's audience tag |
| `AHM_OWNER_EMAIL` | The single owner email allowed by the Access policy |

On the first authenticated-mode startup, the API creates `org_private` and
`user_owner` with an owner membership. Existing workspaces are not modified;
removing a membership is not undone by a restart.

## Cloudflare Access

1. Activate Access and create a team with an email sign-in provider.
2. Create a self-hosted application for `skill-manager.omarjetti.dev` allowing
   only the configured owner email. Use a 24-hour session and an HttpOnly cookie.
3. Create a more-specific application for `skill-manager.omarjetti.dev/runner/*`
   with an Access bypass policy. Runner routes retain their existing bearer
   credential checks; enrollment requires an expiring single-use code.
4. Set the browser application's issuer and audience in Railway.
5. DNS: proxied A record `skill-manager` pointing to Vercel's assigned target.
   Keep TLS verification enabled from Cloudflare to Vercel.

The API verifies the Access token's signature, issuer, audience, expiration,
application type, and owner email. It ignores browser actor headers in hosted
mode and checks the request Origin for mutations. Direct Railway URLs therefore
cannot bypass authentication. API and runner responses are marked `no-store`.

## Verification

Run `npm run check` before deploying. After deployment, verify:

- The public domain shows the Cloudflare login page when signed out.
- Signed-in browser requests can list and create projects.
- Direct Railway `/api/v1/projects` requests without an Access token return 401.
- `/runner/v1/jobs/claim` remains accessible to the runner but rejects missing
  bearer credentials with 401.
- A generated enrollment command can connect a local runner through the custom
  domain, and its inventory is visible in the browser.

Private sign-in requires the owner's email verification step. Never bypass that
step or disable Access to complete a deployment smoke test.
