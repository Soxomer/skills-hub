import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { betterAuth } from 'better-auth'
import { hashPassword } from 'better-auth/crypto'
import { newDb } from 'pg-mem'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { hostedAuthConfig, hostedAuthOptions, createHostedAuthenticator, registerHostedAuth, ensurePrivateWorkspace, type HostedAuthConfig } from '../src/hosted-auth.js'
import { createControlPlaneApp } from '../src/http.js'
import { ProjectService } from '../src/projects.js'
import { InMemoryProjectRepository } from '../src/projects-memory.js'
import { RunnerTransportService } from '../src/runner-transport.js'
import { InMemoryRunnerTransportRepository } from '../src/runner-transport-memory.js'

const password = 'test-only-long-password-123!'
const config: HostedAuthConfig = {
  secret: randomBytes(48).toString('base64url'), ownerPasswordHash: await hashPassword(password),
  ownerEmail: 'owner@example.com', publicOrigin: 'https://hub.example.com',
  actor: { organizationId: 'org_private', userId: 'user_owner' },
}
async function harness() {
  const db = newDb()
  db.public.none(`CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT, created_at TIMESTAMPTZ);
    CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT, created_at TIMESTAMPTZ);
    CREATE TABLE organization_memberships (organization_id TEXT, user_id TEXT, role TEXT, created_at TIMESTAMPTZ);
    CREATE TABLE control_plane_schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ);`)
  db.public.none(await readFile(new URL('../migrations/0008_better_auth.sql', import.meta.url), 'utf8'))
  const adapter = db.adapters.createPg()
  const pool = new adapter.Pool() as unknown as Pool
  await ensurePrivateWorkspace(pool, config)
  const options = hostedAuthOptions(pool, config)
  // pg-mem has no PostgreSQL catalog introspection. Production keeps schema validation enabled.
  const auth = betterAuth({ ...options, advanced: { ...options.advanced, database: { validateSchema: false } } })
  const transport = new RunnerTransportService(new InMemoryRunnerTransportRepository(), { serverUrl: config.publicOrigin })
  const app = createControlPlaneApp(transport, new ProjectService(new InMemoryProjectRepository()), undefined, undefined, createHostedAuthenticator(config, auth))
  registerHostedAuth(app, auth, config)
  const headers = { origin: config.publicOrigin, 'x-forwarded-for': '203.0.113.1' }
  const signIn = (pass = password) => app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers,
    payload: { email: config.ownerEmail, password: pass } })
  return { app, pool, signIn, headers, close: async () => { await app.close(); await pool.end() } }
}
describe('Better Auth hosted sessions', () => {
  it('signs in, protects API data, checks origins, and revokes the session on sign out', async () => {
    const h = await harness()
    try {
      expect((await h.app.inject('/api/v1/projects')).statusCode).toBe(401)
      const libraryPayload = { command: 'get_featured_skills', args: {}, expectedDigest: null }
      expect((await h.app.inject({ method: 'POST', url: '/api/v1/library/catalogue', payload: libraryPayload })).statusCode).toBe(401)
      expect((await h.app.inject({ method: 'POST', url: '/api/v1/runners/private-device/library', payload: libraryPayload })).statusCode).toBe(401)
      expect((await h.signIn('incorrect-password')).statusCode).toBe(401)
      const login = await h.signIn()
      expect(login.statusCode, login.body).toBe(200)
      const setCookies = [login.headers['set-cookie']].flat().filter((v): v is string => Boolean(v))
      expect(setCookies.join(';')).toContain('HttpOnly')
      expect(setCookies.join(';')).toContain('Secure')
      const cookie = setCookies.map(v => v.split(';')[0]).join('; ')
      const sessionHeaders = { cookie, ...h.headers, 'x-ahm-user-id': 'attacker', 'x-ahm-organization-id': 'attacker' }
      const projects = await h.app.inject({ url: '/api/v1/projects', headers: sessionHeaders })
      expect(projects.statusCode).toBe(200)
      expect(projects.headers['cache-control']).toBe('private, no-store')
      expect((await h.app.inject({ method: 'POST', url: '/api/v1/library/catalogue', headers: { ...sessionHeaders, origin: 'https://attacker.example' }, payload: libraryPayload })).statusCode).toBe(403)
      expect((await h.app.inject({ method: 'POST', url: '/api/v1/projects', headers: { ...sessionHeaders, origin: 'https://attacker.example' }, payload: { name: 'Test' } })).statusCode).toBe(403)
      expect((await h.app.inject({ method: 'POST', url: '/api/auth/sign-out', headers: sessionHeaders, payload: {} })).statusCode).toBe(200)
      expect((await h.app.inject({ url: '/api/v1/projects', headers: sessionHeaders })).statusCode).toBe(401)
      expect((await h.app.inject('/health')).statusCode).toBe(200)
      expect((await h.app.inject({ method: 'POST', url: '/runner/v1/jobs/claim', payload: {} })).statusCode).toBe(401)
    } finally { await h.close() }
  })
  it('disables public registration and rejects cross-origin sign-in', async () => {
    const h = await harness()
    try {
      expect((await h.app.inject({ method: 'POST', url: '/api/auth/sign-up/email', headers: h.headers,
        payload: { name: 'Intruder', email: 'intruder@example.com', password } })).statusCode).toBe(400)
      expect((await h.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: { origin: 'https://attacker.example' },
        payload: { email: config.ownerEmail, password } })).statusCode).toBe(403)
      expect((await h.pool.query('SELECT email FROM auth_user')).rows).toEqual([{ email: config.ownerEmail }])
    } finally { await h.close() }
  })
  it('does not reset the password or restore a removed membership on restart', async () => {
    const h = await harness()
    try {
      await h.pool.query('DELETE FROM organization_memberships')
      await ensurePrivateWorkspace(h.pool, { ...config, ownerPasswordHash: await hashPassword('different-password-456!') })
      expect((await h.pool.query('SELECT * FROM organization_memberships')).rows).toEqual([])
      expect((await h.signIn()).statusCode).toBe(200)
    } finally { await h.close() }
  })
})
describe('hosted configuration', () => {
  const env = { NODE_ENV: 'production', AHM_AUTH_MODE: 'better-auth', BETTER_AUTH_SECRET: config.secret,
    AHM_OWNER_PASSWORD_HASH: config.ownerPasswordHash, AHM_OWNER_EMAIL: config.ownerEmail, PUBLIC_SERVER_URL: config.publicOrigin }
  it('fails closed on absent authentication or invalid configuration', () => {
    expect(() => hostedAuthConfig({ NODE_ENV: 'production' })).toThrow('Production requires')
    expect(() => hostedAuthConfig({ AHM_AUTH_MODE: 'cloudflare' })).toThrow('Unsupported')
    for (const key of ['BETTER_AUTH_SECRET', 'AHM_OWNER_PASSWORD_HASH', 'AHM_OWNER_EMAIL', 'PUBLIC_SERVER_URL']) {
      expect(() => hostedAuthConfig({ ...env, [key]: '' })).toThrow('required')
    }
    expect(() => hostedAuthConfig({ ...env, BETTER_AUTH_SECRET: 'short' })).toThrow('32 characters')
    expect(() => hostedAuthConfig({ ...env, AHM_OWNER_PASSWORD_HASH: password })).toThrow('scrypt hash')
    expect(() => hostedAuthConfig({ ...env, PUBLIC_SERVER_URL: 'http://hub.example.com' })).toThrow('HTTPS origin')
    expect(hostedAuthConfig(env)).toEqual(config)
    expect(hostedAuthConfig({})).toBeUndefined()
  })
})
