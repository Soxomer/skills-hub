import type { RunnerCapabilityReport } from '@ahm/contracts'
import type { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'

import { requireDevelopmentLoopback, type MembershipRole } from '../src/development-auth.js'
import { createControlPlaneApp } from '../src/http.js'
import { InMemoryProjectRepository } from '../src/projects-memory.js'
import { ProjectService } from '../src/projects.js'
import { InMemoryRunnerTransportRepository } from '../src/runner-transport-memory.js'
import { PostgresRunnerTransportRepository } from '../src/runner-transport-pg.js'
import { RunnerTransportService } from '../src/runner-transport.js'

const actor = { organizationId: 'org', userId: 'owner' }
const capabilities: RunnerCapabilityReport = {
  protocolVersion: '1.0', supportedProtocolVersions: ['1.0'], runnerVersion: '0.9.1',
  capabilities: { scanProject: true, planSetup: false, applyPlan: false,
    rollbackOperation: false, supportedTools: ['codex'] },
}

async function harness() {
  const repository = new InMemoryRunnerTransportRepository()
  repository.seedMembership(actor, 'owner')
  repository.seedProject('org', 'project')
  const service = new RunnerTransportService(repository, { serverUrl: 'http://127.0.0.1:8787' })
  const enrollment = await service.createEnrollment(actor)
  const runner = await service.enroll({ code: enrollment.code, label: 'Runner', capabilities })
  await service.registerProjectInstance(runner.credential, { projectId: 'project', projectInstanceId: 'instance' })
  const job = await service.enqueueScan(actor, 'instance', true)
  const app = createControlPlaneApp(service, new ProjectService(new InMemoryProjectRepository()))
  const routes = [
    { method: 'POST' as const, url: '/api/v1/runner-enrollments', write: true },
    { method: 'GET' as const, url: `/api/v1/runner-enrollments/${enrollment.enrollmentId}`, write: false },
    { method: 'GET' as const, url: `/api/v1/runners/${runner.deviceId}`, write: false },
    { method: 'POST' as const, url: '/api/v1/project-instances/instance/scan', write: true },
    { method: 'GET' as const, url: `/api/v1/jobs/${job.jobId}`, write: false },
    { method: 'POST' as const, url: `/api/v1/jobs/${job.jobId}/cancel`, write: true },
    { method: 'POST' as const, url: `/api/v1/runners/${runner.deviceId}/revoke`, write: true },
  ]
  return { repository, service, app, routes, job, runner }
}

describe('development actor authorization', () => {
  it.each(['absent', 'viewer', 'member', 'admin', 'owner'] as const)(
    'checks membership and access on every browser runner route for %s', async (role) => {
      const { app, repository, routes } = await harness()
      const testActor = { organizationId: 'org', userId: 'test-user' }
      if (role !== 'absent') repository.seedMembership(testActor, role)
      try {
        for (const { method, url, write } of routes) {
          const response = await app.inject({ method, url, headers: {
            'x-ahm-organization-id': 'org', 'x-ahm-user-id': 'test-user',
          } })
          if (role === 'absent' || (role === 'viewer' && write)) {
            expect(response.statusCode, `${method} ${url}`).toBe(403)
          } else {
            expect(response.statusCode, `${method} ${url}`).toBeGreaterThanOrEqual(200)
            expect(response.statusCode, `${method} ${url}`).toBeLessThan(300)
          }
        }
      } finally { await app.close() }
    },
  )

  it('denies removed memberships immediately without cancelling the job or revoking the device', async () => {
    const { app, repository, service, job, runner } = await harness()
    repository.removeMembership(actor)
    await expect(service.cancelJob(actor, job.jobId)).rejects.toMatchObject({ statusCode: 403 })
    await expect(service.revokeRunner(actor, runner.deviceId)).rejects.toMatchObject({ statusCode: 403 })
    expect(await repository.jobStatus('org', job.jobId)).toMatchObject({ state: 'pending', cancelRequested: false })
    expect(await repository.runnerStatus('org', runner.deviceId)).toMatchObject({ status: 'active' })
    await app.close()
  })

  it('does not grant another organization access to existing objects', async () => {
    const { app, repository, routes } = await harness()
    repository.seedMembership({ organizationId: 'other', userId: 'owner' }, 'owner')
    try {
      for (const { method, url } of routes.slice(1)) {
        const response = await app.inject({ method, url, headers: {
          'x-ahm-organization-id': 'other', 'x-ahm-user-id': 'owner',
        } })
        expect(response.statusCode, `${method} ${url}`).toBe(404)
      }
    } finally { await app.close() }
  })
})

describe('transaction-bound membership checks', () => {
  function database(role?: MembershipRole) {
    const statements: string[] = []
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql)
        return { rows: sql.startsWith('SELECT role') && role ? [{ role }] : [], rowCount: 1 }
      }),
      release: vi.fn(),
    }
    const pool = { connect: vi.fn(async () => client), query: vi.fn() }
    return { pool, client, statements, repository: new PostgresRunnerTransportRepository(pool as unknown as Pool) }
  }

  it('holds a shared membership lock and inserts enrollment on that same transaction', async () => {
    const { repository, pool, client, statements } = database('member')
    await repository.withActor(actor, 'write', (scoped) => scoped.createEnrollment({
      id: 'enrollment', organizationId: 'org', createdBy: 'owner', codeHash: 'hash', state: 'waiting',
      claimedDeviceId: null, claimedAt: null, createdAt: '2026-09-08T10:00:00Z', expiresAt: '2026-09-08T10:10:00Z',
    }))
    expect(statements[0]).toBe('BEGIN')
    expect(statements[1]).toContain('FOR SHARE')
    expect(statements[2]).toContain('INSERT INTO runner_enrollments')
    expect(statements[3]).toBe('COMMIT')
    expect(pool.query).not.toHaveBeenCalled()
    expect(client.release).toHaveBeenCalledOnce()
  })

  it.each([undefined, 'viewer'] as const)('rolls back before invoking a write for %s membership', async (role) => {
    const { repository, statements, client } = database(role)
    const mutation = vi.fn()
    await expect(repository.withActor(actor, 'write', mutation)).rejects.toMatchObject({ statusCode: 403 })
    expect(mutation).not.toHaveBeenCalled()
    expect(statements.at(-1)).toBe('ROLLBACK')
    expect(client.release).toHaveBeenCalledOnce()
  })
})

describe('development header listener boundary', () => {
  it.each(['127.0.0.1', '127.0.0.2', '::1'])('allows literal loopback %s', (host) => {
    expect(() => requireDevelopmentLoopback(host)).not.toThrow()
  })
  it.each(['0.0.0.0', '::', '192.168.1.10', '10.0.0.1', 'example.com', 'localhost', '127.evil.test', ''])(
    'refuses public, ambiguous, or unresolved bind %s', (host) => {
      expect(() => requireDevelopmentLoopback(host)).toThrow('loopback bind')
    })
})
