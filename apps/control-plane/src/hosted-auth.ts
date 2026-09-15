import type { FastifyInstance, FastifyRequest } from 'fastify'
import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { fromNodeHeaders } from 'better-auth/node'
import type { Pool } from 'pg'
import { RunnerTransportError, type RequestActor } from './runner-transport.js'

export type BrowserAuthenticator = (request: FastifyRequest) => Promise<RequestActor>
export interface HostedAuthConfig {
  secret: string
  ownerPasswordHash: string
  ownerEmail: string
  publicOrigin: string
  actor: RequestActor
}
export function hostedAuthConfig(env: NodeJS.ProcessEnv): HostedAuthConfig | undefined {
  const mode = env.AHM_AUTH_MODE ?? 'development'
  if (mode === 'development') {
    if (env.NODE_ENV === 'production') throw new Error('Production requires AHM_AUTH_MODE=better-auth')
    return undefined
  }
  if (mode !== 'better-auth') throw new Error('Unsupported AHM_AUTH_MODE')
  const required = (name: string) => {
    const value = env[name]?.trim()
    if (!value) throw new Error(`${name} is required for hosted authentication`)
    return value
  }
  const secret = required('BETTER_AUTH_SECRET')
  if (secret.length < 32) throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters')
  const ownerPasswordHash = required('AHM_OWNER_PASSWORD_HASH')
  if (!/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(ownerPasswordHash)) throw new Error('AHM_OWNER_PASSWORD_HASH must be a Better Auth scrypt hash')
  const publicUrl = new URL(required('PUBLIC_SERVER_URL'))
  if (publicUrl.protocol !== 'https:' || publicUrl.pathname !== '/' || publicUrl.search ||
      publicUrl.hash || publicUrl.username || publicUrl.password) throw new Error('PUBLIC_SERVER_URL must be an HTTPS origin')
  const ownerEmail = required('AHM_OWNER_EMAIL').toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) throw new Error('AHM_OWNER_EMAIL must be an email address')
  return { secret, ownerPasswordHash, ownerEmail, publicOrigin: publicUrl.origin,
    actor: { organizationId: 'org_private', userId: 'user_owner' } }
}
export function hostedAuthOptions(pool: Pool, config: HostedAuthConfig) {
  return {
    database: pool,
    secret: config.secret,
    baseURL: config.publicOrigin,
    trustedOrigins: [config.publicOrigin],
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12, revokeSessionsOnPasswordReset: true },
    user: { modelName: 'auth_user' },
    account: { modelName: 'auth_account' },
    verification: { modelName: 'auth_verification' },
    session: { modelName: 'auth_session', expiresIn: 86_400, cookieCache: { enabled: false } },
    rateLimit: { enabled: true, storage: 'database', modelName: 'auth_rate_limit',
      customRules: { '/sign-in/email': { window: 60, max: 5 } } },
    advanced: { useSecureCookies: true },
    telemetry: { enabled: false },
  } satisfies BetterAuthOptions
}
export function createHostedAuth(pool: Pool, config: HostedAuthConfig) {
  return betterAuth(hostedAuthOptions(pool, config))
}
export type HostedAuth = ReturnType<typeof createHostedAuth>
export function createHostedAuthenticator(config: HostedAuthConfig, auth: HostedAuth): BrowserAuthenticator {
  return async (request) => {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) })
    if (!session || session.user.id !== 'auth_owner' || session.user.email.toLowerCase() !== config.ownerEmail) {
      throw new RunnerTransportError(401, 'Sign in to continue')
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin !== config.publicOrigin) {
      throw new RunnerTransportError(403, 'Request origin is not allowed')
    }
    return { ...config.actor }
  }
}
export function registerHostedAuth(app: FastifyInstance, auth: HostedAuth, config: HostedAuthConfig) {
  app.route({ method: ['GET', 'POST'], url: '/api/auth/*', async handler(request, reply) {
    if (request.method === 'POST' && request.headers.origin !== config.publicOrigin) {
      return reply.code(403).send({ error: 'Request origin is not allowed' })
    }
    // Canonical configured origin prevents Host/forwarded-host injection behind either proxy.
    const response = await auth.handler(new Request(new URL(request.url, config.publicOrigin), {
      method: request.method, headers: fromNodeHeaders(request.headers),
      ...(request.body ? { body: JSON.stringify(request.body) } : {}),
    }))
    reply.code(response.status)
    response.headers.forEach((value, key) => { if (key !== 'set-cookie') reply.header(key, value) })
    const cookies = response.headers.getSetCookie()
    if (cookies.length) reply.header('set-cookie', cookies)
    return reply.send(response.body ? await response.text() : null)
  } })
}
/** Seed the configured owner once. Restarts never reset their password or restore membership. */
export async function ensurePrivateWorkspace(pool: Pool, config: HostedAuthConfig): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const existingOwner = await client.query("SELECT id FROM auth_user WHERE id = 'auth_owner'")
    if (!existingOwner.rows.length) {
      const owner = await client.query(`INSERT INTO auth_user (id, name, email, "emailVerified", "createdAt", "updatedAt")
      VALUES ('auth_owner', 'Owner', $1, false, NOW(), NOW()) ON CONFLICT (id) DO NOTHING RETURNING id`, [config.ownerEmail])
    if (owner.rowCount) await client.query(`INSERT INTO auth_account
      (id, "userId", "accountId", "providerId", password, "createdAt", "updatedAt")
      VALUES ('auth_owner_credential', 'auth_owner', 'auth_owner', 'credential', $1, NOW(), NOW())`, [config.ownerPasswordHash])
    }
    const existing = await client.query('SELECT id FROM organizations WHERE id = $1', [config.actor.organizationId])
    if (!existing.rows.length) {
      const created = await client.query(`INSERT INTO organizations (id, name, created_at) VALUES ($1, 'Private workspace', NOW())
        ON CONFLICT (id) DO NOTHING RETURNING id`, [config.actor.organizationId])
      if (created.rowCount) {
        await client.query(`INSERT INTO users (id, display_name, created_at) VALUES ($1, $2, NOW()) ON CONFLICT (id) DO NOTHING`,
          [config.actor.userId, config.ownerEmail])
        await client.query(`INSERT INTO organization_memberships (organization_id, user_id, role, created_at)
          VALUES ($1, $2, 'owner', NOW())`, [config.actor.organizationId, config.actor.userId])
      }
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}
