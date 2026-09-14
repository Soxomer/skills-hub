import type { FastifyRequest } from 'fastify'
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import type { Pool } from 'pg'

import { RunnerTransportError, type RequestActor } from './runner-transport.js'

export type BrowserAuthenticator = (request: FastifyRequest) => Promise<RequestActor>

export interface CloudflareAuthConfig {
  issuer: string
  audience: string
  ownerEmail: string
  publicOrigin: string
  actor: RequestActor
}

export function cloudflareAuthConfig(env: NodeJS.ProcessEnv): CloudflareAuthConfig | undefined {
  const mode = env.AHM_AUTH_MODE ?? 'development'
  if (mode === 'development') {
    if (env.NODE_ENV === 'production') throw new Error('Production requires AHM_AUTH_MODE=cloudflare')
    return undefined
  }
  if (mode !== 'cloudflare') throw new Error('Unsupported AHM_AUTH_MODE')
  const required = (name: string): string => {
    const value = env[name]?.trim()
    if (!value) throw new Error(`${name} is required for Cloudflare authentication`)
    return value
  }
  const issuer = new URL(required('CF_ACCESS_TEAM_URL'))
  if (issuer.protocol !== 'https:' || !issuer.hostname.endsWith('.cloudflareaccess.com') ||
      issuer.pathname !== '/' || issuer.search || issuer.hash || issuer.username || issuer.password || issuer.port) {
    throw new Error('CF_ACCESS_TEAM_URL must be an HTTPS Cloudflare Access team origin')
  }
  const publicUrl = new URL(required('PUBLIC_SERVER_URL'))
  if (publicUrl.protocol !== 'https:' || publicUrl.pathname !== '/' || publicUrl.search ||
      publicUrl.hash || publicUrl.username || publicUrl.password) {
    throw new Error('PUBLIC_SERVER_URL must be an HTTPS origin')
  }
  const ownerEmail = required('AHM_OWNER_EMAIL').toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) throw new Error('AHM_OWNER_EMAIL must be an email address')
  return {
    issuer: issuer.origin,
    audience: required('CF_ACCESS_AUD'),
    ownerEmail,
    publicOrigin: publicUrl.origin,
    actor: { organizationId: 'org_private', userId: 'user_owner' },
  }
}

export function createCloudflareAuthenticator(
  config: CloudflareAuthConfig,
  keys: JWTVerifyGetKey = createRemoteJWKSet(new URL(`${config.issuer}/cdn-cgi/access/certs`)),
): BrowserAuthenticator {
  return async (request) => {
    const token = request.headers['cf-access-jwt-assertion']
    if (typeof token !== 'string' || !token) throw new RunnerTransportError(401, 'Sign in to continue')
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: ['RS256'],
        requiredClaims: ['exp', 'iat', 'sub', 'email'],
      })
      if (payload.type !== 'app' || typeof payload.sub !== 'string' || !payload.sub ||
          typeof payload.email !== 'string' || payload.email.toLowerCase() !== config.ownerEmail) {
        throw new Error('Identity is not the configured owner')
      }
    } catch {
      throw new RunnerTransportError(401, 'Sign in to continue')
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin !== config.publicOrigin) {
      throw new RunnerTransportError(403, 'Request origin is not allowed')
    }
    // Browser-supplied actor headers never select identity in hosted mode.
    return { ...config.actor }
  }
}

/** Provision the private owner only when creating the workspace for the first time. */
export async function ensurePrivateWorkspace(pool: Pool, config: CloudflareAuthConfig): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const existing = await client.query('SELECT id FROM organizations WHERE id = $1', [config.actor.organizationId])
    if (existing.rows.length) {
      await client.query('COMMIT')
      return
    }
    const created = await client.query(
      `INSERT INTO organizations (id, name, created_at) VALUES ($1, 'Private workspace', NOW())
       ON CONFLICT (id) DO NOTHING RETURNING id`, [config.actor.organizationId],
    )
    if (created.rowCount) {
      await client.query(
        `INSERT INTO users (id, display_name, created_at) VALUES ($1, $2, NOW()) ON CONFLICT (id) DO NOTHING`,
        [config.actor.userId, config.ownerEmail],
      )
      await client.query(
        `INSERT INTO organization_memberships (organization_id, user_id, role, created_at)
         VALUES ($1, $2, 'owner', NOW())`, [config.actor.organizationId, config.actor.userId],
      )
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
