import type { FastifyRequest } from 'fastify'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { newDb } from 'pg-mem'
import type { Pool } from 'pg'
import { beforeAll, describe, expect, it } from 'vitest'

import { cloudflareAuthConfig, createCloudflareAuthenticator, ensurePrivateWorkspace,
  type CloudflareAuthConfig } from '../src/cloudflare-auth.js'
import { createControlPlaneApp } from '../src/http.js'
import { ProjectService } from '../src/projects.js'
import { InMemoryProjectRepository } from '../src/projects-memory.js'
import { RunnerTransportService } from '../src/runner-transport.js'
import { InMemoryRunnerTransportRepository } from '../src/runner-transport-memory.js'

const config: CloudflareAuthConfig = {
  issuer: 'https://test.cloudflareaccess.com', audience: 'application-audience',
  ownerEmail: 'owner@example.com', publicOrigin: 'https://hub.example.com',
  actor: { organizationId: 'org_private', userId: 'user_owner' },
}
let privateKey: CryptoKey
let authenticate: ReturnType<typeof createCloudflareAuthenticator>
beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  privateKey = pair.privateKey
  const jwk = await exportJWK(pair.publicKey)
  authenticate = createCloudflareAuthenticator(config, createLocalJWKSet({ keys: [{ ...jwk, kid: 'test' }] }))
})

async function token(overrides: Record<string, unknown> = {}, signingKey = privateKey) {
  return new SignJWT({ email: config.ownerEmail, type: 'app', ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(config.issuer)
    .setAudience(config.audience).setSubject('owner-subject').setIssuedAt().setExpirationTime('1h')
    .sign(signingKey)
}
function request(jwt: string, method = 'GET', origin?: string) {
  return { method, headers: { 'cf-access-jwt-assertion': jwt, origin,
    'x-ahm-organization-id': 'attacker-org', 'x-ahm-user-id': 'attacker-user' } } as unknown as FastifyRequest
}

describe('hosted browser authentication', () => {
  it('uses only verified identity and ignores spoofed actor headers', async () => {
    expect(await authenticate(request(await token()))).toEqual(config.actor)
  })
  it.each(['', 'not-a-jwt'])('rejects missing or malformed JWTs', async (jwt) => {
    await expect(authenticate(request(jwt))).rejects.toMatchObject({ statusCode: 401 })
  })
  it('rejects another email and service tokens', async () => {
    for (const claims of [{ email: 'other@example.com' }, { type: 'service' }]) {
      await expect(authenticate(request(await token(claims)))).rejects.toMatchObject({ statusCode: 401 })
    }
  })
  it('rejects signatures from an untrusted key', async () => {
    const other = await generateKeyPair('RS256')
    await expect(authenticate(request(await token({}, other.privateKey)))).rejects.toMatchObject({ statusCode: 401 })
  })
  it.each(['issuer', 'audience', 'expired', 'missing-expiration'] as const)('rejects %s', async (condition) => {
    let jwt = new SignJWT({ email: config.ownerEmail, type: 'app' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setSubject('owner')
      .setIssuer(condition === 'issuer' ? 'https://other.cloudflareaccess.com' : config.issuer)
      .setAudience(condition === 'audience' ? 'other-app' : config.audience).setIssuedAt()
    if (condition !== 'missing-expiration') jwt = jwt.setExpirationTime(condition === 'expired' ? '0s' : '1h')
    await expect(authenticate(request(await jwt.sign(privateKey)))).rejects.toMatchObject({ statusCode: 401 })
  })
  it('requires same-origin browser mutations', async () => {
    const jwt = await token()
    for (const origin of [undefined, 'https://attacker.example']) {
      await expect(authenticate(request(jwt, 'POST', origin))).rejects.toMatchObject({ statusCode: 403 })
    }
    expect(await authenticate(request(jwt, 'POST', config.publicOrigin))).toEqual(config.actor)
  })
  it('protects browser endpoints while preserving health and runner credential checks', async () => {
    const transport = new RunnerTransportService(new InMemoryRunnerTransportRepository(), { serverUrl: config.publicOrigin })
    const app = createControlPlaneApp(transport, new ProjectService(new InMemoryProjectRepository()), undefined, undefined, authenticate)
    try {
      expect((await app.inject('/api/v1/projects')).statusCode).toBe(401)
      const response = await app.inject({ url: '/api/v1/projects', headers: {
        'cf-access-jwt-assertion': await token(), 'x-ahm-user-id': 'spoofed',
      } })
      expect(response.statusCode).toBe(200)
      expect(response.headers['cache-control']).toBe('private, no-store')
      expect((await app.inject('/health')).statusCode).toBe(200)
      expect((await app.inject({ method: 'POST', url: '/runner/v1/jobs/claim', payload: {} })).statusCode).toBe(401)
      const enrollment = await app.inject({ method: 'POST', url: '/runner/v1/enroll', payload: {
        code: 'invalid', label: 'Test runner', capabilities: { protocolVersion: '1.0',
          supportedProtocolVersions: ['1.0'], runnerVersion: '0.9.1', capabilities: {
            scanProject: true, planSetup: false, applyPlan: false, rollbackOperation: false, supportedTools: ['codex'],
          } },
      } })
      expect(enrollment.statusCode).toBe(404)
    } finally { await app.close() }
  })
})

describe('hosted configuration', () => {
  const env = { NODE_ENV: 'production', AHM_AUTH_MODE: 'cloudflare',
    CF_ACCESS_TEAM_URL: config.issuer, CF_ACCESS_AUD: config.audience,
    AHM_OWNER_EMAIL: config.ownerEmail, PUBLIC_SERVER_URL: config.publicOrigin }
  it('requires authentication in production and fails closed on incomplete configuration', () => {
    expect(() => cloudflareAuthConfig({ NODE_ENV: 'production' })).toThrow('Production requires')
    expect(() => cloudflareAuthConfig({ AHM_AUTH_MODE: 'unknown' })).toThrow('Unsupported')
    for (const key of ['CF_ACCESS_TEAM_URL', 'CF_ACCESS_AUD', 'AHM_OWNER_EMAIL', 'PUBLIC_SERVER_URL']) {
      expect(() => cloudflareAuthConfig({ ...env, [key]: '' })).toThrow('required')
    }
    expect(cloudflareAuthConfig(env)).toEqual(config)
    expect(cloudflareAuthConfig({})).toBeUndefined()
  })
  it('rejects untrusted key endpoints and insecure public origins', () => {
    expect(() => cloudflareAuthConfig({ ...env, CF_ACCESS_TEAM_URL: 'https://attacker.example' })).toThrow('team origin')
    expect(() => cloudflareAuthConfig({ ...env, PUBLIC_SERVER_URL: 'http://hub.example.com' })).toThrow('HTTPS origin')
  })
  it('creates the owner once and never restores a removed membership on restart', async () => {
    const db = newDb()
    db.public.none(`CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT, created_at TIMESTAMPTZ);
      CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT, created_at TIMESTAMPTZ);
      CREATE TABLE organization_memberships (organization_id TEXT, user_id TEXT, role TEXT, created_at TIMESTAMPTZ);`)
    const adapter = db.adapters.createPg()
    const pool = new adapter.Pool() as unknown as Pool
    try {
      await ensurePrivateWorkspace(pool, config)
      expect((await pool.query('SELECT role FROM organization_memberships')).rows).toEqual([{ role: 'owner' }])
      await pool.query('DELETE FROM organization_memberships')
      await ensurePrivateWorkspace(pool, config)
      expect((await pool.query('SELECT role FROM organization_memberships')).rows).toEqual([])
    } finally { await pool.end() }
  })
})
