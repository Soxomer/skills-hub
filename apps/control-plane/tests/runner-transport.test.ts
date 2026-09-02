import type { RunnerCapabilityReport } from '@ahm/contracts'
import { describe, expect, it } from 'vitest'

import { createControlPlaneApp } from '../src/http.js'
import { InMemoryProjectRepository } from '../src/projects-memory.js'
import { ProjectService } from '../src/projects.js'
import { InMemoryRunnerTransportRepository } from '../src/runner-transport-memory.js'
import { RunnerTransportService } from '../src/runner-transport.js'

const actorHeaders = {
  'x-ahm-organization-id': 'org_01',
  'x-ahm-user-id': 'user_01',
}

const capabilities: RunnerCapabilityReport = {
  protocolVersion: '1.0',
  supportedProtocolVersions: ['1.0'],
  runnerVersion: '0.1.0',
  capabilities: {
    scanProject: true,
    planSetup: false,
    applyPlan: false,
    rollbackOperation: false,
    supportedTools: ['codex'],
  },
}

function harness() {
  let now = new Date('2026-09-01T10:00:00.000Z')
  let sequence = 0
  const repository = new InMemoryRunnerTransportRepository()
  repository.seedProject('org_01', 'project_01')
  const service = new RunnerTransportService(repository, {
    serverUrl: 'https://hub.example.test',
    now: () => now,
    randomId: () => `id_${++sequence}`,
    randomSecret: (bytes) => `secret_${bytes}_${++sequence}`,
    leaseTtlMs: 1_000,
  })
  const app = createControlPlaneApp(service, new ProjectService(new InMemoryProjectRepository()))
  return {
    app,
    advance(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds)
    },
  }
}

async function connect(app: ReturnType<typeof createControlPlaneApp>) {
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/runner-enrollments',
    headers: actorHeaders,
  })
  expect(created.statusCode).toBe(200)
  const enrollment = created.json<{ enrollmentId: string; code: string; command: string }>()
  expect(enrollment.command).toContain('ahm connect')

  const enrolled = await app.inject({
    method: 'POST',
    url: '/runner/v1/enroll',
    payload: { code: enrollment.code, label: 'Laptop', capabilities },
  })
  expect(enrolled.statusCode).toBe(200)
  const identity = enrolled.json<{
    organizationId: string
    deviceId: string
    credential: string
  }>()

  const status = await app.inject({
    method: 'GET',
    url: `/api/v1/runner-enrollments/${enrollment.enrollmentId}`,
    headers: actorHeaders,
  })
  expect(status.json()).toMatchObject({ state: 'claimed', deviceId: identity.deviceId })
  return identity
}

async function acknowledge(
  app: ReturnType<typeof createControlPlaneApp>,
  authorization: { authorization: string },
  jobId: string,
  leaseId: string,
) {
  const response = await app.inject({
    method: 'POST',
    url: `/runner/v1/jobs/${jobId}/ack`,
    headers: authorization,
    payload: { leaseId, requestDigest: `sha256:${'a'.repeat(64)}` },
  })
  expect(response.statusCode).toBe(200)
  expect(response.json()).toEqual({ accepted: true, duplicate: false })
}

describe('runner transport', () => {
  it('enrolls, registers, leases, and acknowledges a remote scan', async () => {
    const { app } = harness()
    const identity = await connect(app)
    const authorization = { authorization: `Bearer ${identity.credential}` }

    const connectedRunner = await app.inject({
      method: 'GET',
      url: `/api/v1/runners/${identity.deviceId}`,
      headers: actorHeaders,
    })
    expect(connectedRunner.statusCode).toBe(200)
    expect(connectedRunner.json()).toMatchObject({
      deviceId: identity.deviceId,
      label: 'Laptop',
      status: 'active',
      lastSeenAt: null,
      projectInstances: [],
    })

    const registration = await app.inject({
      method: 'PUT',
      url: '/runner/v1/project-instances/instance_01',
      headers: authorization,
      payload: { projectId: 'project_01' },
    })
    expect(registration.statusCode).toBe(204)

    const registeredRunner = await app.inject({
      method: 'GET',
      url: `/api/v1/runners/${identity.deviceId}`,
      headers: actorHeaders,
    })
    expect(registeredRunner.json()).toMatchObject({
      lastSeenAt: null,
      projectInstances: [
        {
          projectInstanceId: 'instance_01',
          projectId: 'project_01',
          registeredAt: '2026-09-01T10:00:00.000Z',
          lastSeenAt: '2026-09-01T10:00:00.000Z',
        },
      ],
    })

    const queued = await app.inject({
      method: 'POST',
      url: '/api/v1/project-instances/instance_01/scan',
      headers: actorHeaders,
      payload: { includeUnmanaged: true },
    })
    const { jobId } = queued.json<{ jobId: string }>()

    const claimed = await app.inject({
      method: 'POST',
      url: '/runner/v1/jobs/claim',
      headers: authorization,
      payload: { capabilities },
    })
    expect(claimed.statusCode).toBe(200)
    const lease = claimed.json<{
      leaseId: string
      job: { idempotencyKey: string; projectInstanceId: string }
    }>()
    await acknowledge(app, authorization, jobId, lease.leaseId)

    const result = {
      protocolVersion: '1.0',
      jobId,
      idempotencyKey: lease.job.idempotencyKey,
      organizationId: identity.organizationId,
      deviceId: identity.deviceId,
      projectInstanceId: lease.job.projectInstanceId,
      result: {
        kind: 'scanResult',
        payload: { projectId: 'project_01', discoveries: [] },
      },
    }
    const submitted = await app.inject({
      method: 'POST',
      url: `/runner/v1/jobs/${jobId}/result`,
      headers: authorization,
      payload: { leaseId: lease.leaseId, result },
    })
    expect(submitted.json()).toEqual({ accepted: true, duplicate: false })

    const duplicate = await app.inject({
      method: 'POST',
      url: `/runner/v1/jobs/${jobId}/result`,
      headers: authorization,
      payload: { leaseId: lease.leaseId, result },
    })
    expect(duplicate.json()).toEqual({ accepted: true, duplicate: true })

    const status = await app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${jobId}`,
      headers: actorHeaders,
    })
    expect(status.json()).toMatchObject({ state: 'succeeded', result })
    await app.close()
  })

  it('re-leases after expiry and rejects revoked credentials', async () => {
    const { app, advance } = harness()
    const identity = await connect(app)
    const authorization = { authorization: `Bearer ${identity.credential}` }
    await app.inject({
      method: 'PUT',
      url: '/runner/v1/project-instances/instance_01',
      headers: authorization,
      payload: { projectId: 'project_01' },
    })
    await app.inject({
      method: 'POST',
      url: '/api/v1/project-instances/instance_01/scan',
      headers: actorHeaders,
    })

    const first = await app.inject({
      method: 'POST',
      url: '/runner/v1/jobs/claim',
      headers: authorization,
      payload: { capabilities },
    })
    const firstLease = first.json<{ leaseId: string }>().leaseId
    advance(1_001)
    const second = await app.inject({
      method: 'POST',
      url: '/runner/v1/jobs/claim',
      headers: authorization,
      payload: { capabilities },
    })
    expect(second.json<{ leaseId: string }>().leaseId).not.toBe(firstLease)

    const revoked = await app.inject({
      method: 'POST',
      url: `/api/v1/runners/${identity.deviceId}/revoke`,
      headers: actorHeaders,
    })
    expect(revoked.statusCode).toBe(204)
    const unauthorized = await app.inject({
      method: 'POST',
      url: '/runner/v1/jobs/claim',
      headers: authorization,
      payload: { capabilities },
    })
    expect(unauthorized.statusCode).toBe(401)
    await app.close()
  })

  it('expires unused enrollment codes', async () => {
    const { app, advance } = harness()
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/runner-enrollments',
      headers: actorHeaders,
    })
    const enrollment = created.json<{ enrollmentId: string; code: string }>()
    advance(10 * 60_000 + 1)

    const rejected = await app.inject({
      method: 'POST',
      url: '/runner/v1/enroll',
      payload: { code: enrollment.code, label: 'Late runner', capabilities },
    })
    expect(rejected.statusCode).toBe(404)
    const status = await app.inject({
      method: 'GET',
      url: `/api/v1/runner-enrollments/${enrollment.enrollmentId}`,
      headers: actorHeaders,
    })
    expect(status.json()).toMatchObject({ state: 'expired' })
    await app.close()
  })

  it('propagates cancellation to leased work', async () => {
    const { app } = harness()
    const identity = await connect(app)
    const authorization = { authorization: `Bearer ${identity.credential}` }
    await app.inject({
      method: 'PUT',
      url: '/runner/v1/project-instances/instance_01',
      headers: authorization,
      payload: { projectId: 'project_01' },
    })
    const queued = await app.inject({
      method: 'POST',
      url: '/api/v1/project-instances/instance_01/scan',
      headers: actorHeaders,
    })
    const { jobId } = queued.json<{ jobId: string }>()
    const firstClaim = await app.inject({
      method: 'POST',
      url: '/runner/v1/jobs/claim',
      headers: authorization,
      payload: { capabilities },
    })
    const lease = firstClaim.json<{ leaseId: string; job: Record<string, string> }>()
    await acknowledge(app, authorization, jobId, lease.leaseId)
    await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${jobId}/cancel`,
      headers: actorHeaders,
    })
    const cancelledClaim = await app.inject({
      method: 'POST',
      url: '/runner/v1/jobs/claim',
      headers: authorization,
      payload: { capabilities },
    })
    expect(cancelledClaim.json()).toMatchObject({
      leaseId: lease.leaseId,
      cancelRequested: true,
    })

    const result = {
      protocolVersion: '1.0',
      jobId,
      idempotencyKey: lease.job.idempotencyKey,
      organizationId: identity.organizationId,
      deviceId: identity.deviceId,
      projectInstanceId: lease.job.projectInstanceId,
      result: {
        kind: 'error',
        payload: {
          code: 'jobCancelled',
          message: 'job was cancelled',
          retryable: false,
          recoverability: 'notNeeded',
        },
      },
    }
    const submitted = await app.inject({
      method: 'POST',
      url: `/runner/v1/jobs/${jobId}/result`,
      headers: authorization,
      payload: { leaseId: lease.leaseId, result },
    })
    expect(submitted.statusCode).toBe(200)
    const status = await app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${jobId}`,
      headers: actorHeaders,
    })
    expect(status.json()).toMatchObject({ state: 'cancelled' })
    await app.close()
  })

  it('wakes a held outbound claim as soon as durable work is enqueued', async () => {
    const { app } = harness()
    const identity = await connect(app)
    const authorization = { authorization: `Bearer ${identity.credential}` }
    await app.inject({
      method: 'PUT',
      url: '/runner/v1/project-instances/instance_01',
      headers: authorization,
      payload: { projectId: 'project_01' },
    })

    const waitingClaim = app.inject({
      method: 'POST',
      url: '/runner/v1/jobs/claim',
      headers: authorization,
      payload: { capabilities, waitMs: 5_000 },
    })
    await Promise.resolve()
    const queued = await app.inject({
      method: 'POST',
      url: '/api/v1/project-instances/instance_01/scan',
      headers: actorHeaders,
    })
    const response = await waitingClaim

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ job: { jobId: queued.json().jobId } })
    await app.close()
  })

  it('stores and retrieves content-addressed artifacts for the organization', async () => {
    const { app } = harness()
    const identity = await connect(app)
    const authorization = { authorization: `Bearer ${identity.credential}` }
    const contentDigest = `sha256:${'f'.repeat(64)}`
    const bundle = {
      contentDigest,
      entries: [
        { path: 'SKILL.md', kind: 'file', contentBase64: btoa('# Shared') },
      ],
    }
    const stored = await app.inject({
      method: 'PUT',
      url: '/runner/v1/artifacts',
      headers: authorization,
      payload: bundle,
    })
    expect(stored.statusCode).toBe(204)
    const loaded = await app.inject({
      method: 'GET',
      url: `/runner/v1/artifacts/${contentDigest}`,
      headers: authorization,
    })
    expect(loaded.json()).toEqual(bundle)
    await app.close()
  })
})
