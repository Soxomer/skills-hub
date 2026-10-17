import { isLibrarySetupSnapshot, type ArtifactBundleEntry, type LibrarySetupSnapshot, type ResultEnvelope, type RunnerCapabilityReport } from '@ahm/contracts'
import { describe, expect, it, vi } from 'vitest'

import { createControlPlaneApp } from '../src/http.js'
import { InMemoryProjectRepository } from '../src/projects-memory.js'
import { ProjectService } from '../src/projects.js'
import { InMemoryRunnerTransportRepository } from '../src/runner-transport-memory.js'
import { RunnerTransportService } from '../src/runner-transport.js'
import { artifactDigest } from '../src/artifact-digest.js'

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
    rollbackOperation: false, library: true,
    supportedTools: ['codex'],
  },
}

function harness() {
  let now = new Date('2026-09-01T10:00:00.000Z')
  let sequence = 0
  const repository = new InMemoryRunnerTransportRepository()
  repository.seedMembership({ organizationId: 'org_01', userId: 'user_01' }, 'owner')
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
    repository,
    service,
    advance(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds)
    },
  }
}

it('reports a runner-owned library with tenant isolation and preserves it between reports', async () => {
  const { app } = harness()
  const identity = await connect(app)
  const skills = [{ id: 'review', name: 'Review', sourceType: 'git', enabled: true, tags: ['Quality'], targets: [{ tool: 'codex', scope: 'global' }] }]
  const claim = (skillLibrary?: unknown) => app.inject({ method: 'POST', url: '/runner/v1/jobs/claim', headers: { authorization: `Bearer ${identity.credential}` }, payload: { capabilities, waitMs: 0, ...(skillLibrary === undefined ? {} : { skillLibrary }) } })
  expect((await claim(skills)).statusCode).toBe(204)
  const status = () => app.inject({ method: 'GET', url: `/api/v1/runners/${identity.deviceId}`, headers: actorHeaders })
  expect((await status()).json().skillLibrary.skills).toEqual(skills)
  await claim()
  expect((await status()).json().skillLibrary.skills).toEqual(skills)
  expect((await claim([{ ...skills[0], centralPath: '/private' }])).statusCode).toBe(400)
  expect((await status()).json().skillLibrary.skills).toEqual(skills)
  const foreign = await app.inject({ method: 'GET', url: `/api/v1/runners/${identity.deviceId}`, headers: { ...actorHeaders, 'x-ahm-organization-id': 'other' } })
  expect([403, 404]).toContain(foreign.statusCode)
  await claim([])
  expect((await status()).json().skillLibrary.skills).toEqual([])
  await app.close()
})

async function connect(app: ReturnType<typeof createControlPlaneApp>, report = capabilities) {
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
    payload: { code: enrollment.code, label: 'Laptop', capabilities: report },
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

const snapshotCapabilities = { ...capabilities, capabilities: { ...capabilities.capabilities, setupSnapshots: true } }
const snapshotCommands = ['preview_setup_skill', 'snapshot_setup_skill'] as const
const snapshotRequest = (command: typeof snapshotCommands[number]) => ({ command, args: { skillId: 'review' }, expectedDigest: command === 'snapshot_setup_skill' ? `sha256:${'a'.repeat(64)}` : null })

it.each(snapshotCommands.flatMap(command => [undefined, false].map(supported => ({ command, supported }))))('rejects $command with setupSnapshots=$supported before inserting any job', async ({ command, supported }) => {
  const { app, repository } = harness()
  try {
    const report = { ...capabilities, capabilities: { ...capabilities.capabilities, ...(supported === undefined ? {} : { setupSnapshots: supported }) } }
    const identity = await connect(app, report)
    const enqueue = vi.spyOn(repository, 'enqueueJob')
    const response = await app.inject({ method: 'POST', url: `/api/v1/runners/${identity.deviceId}/library`, headers: actorHeaders, payload: snapshotRequest(command) })
    expect(response.statusCode).toBe(409)
    expect(enqueue).not.toHaveBeenCalled()
    const claim = await app.inject({ method: 'POST', url: '/runner/v1/jobs/claim', headers: { authorization: `Bearer ${identity.credential}` }, payload: { capabilities: snapshotCapabilities, waitMs: 0 } })
    expect(claim.statusCode).toBe(204)
  } finally { await app.close() }
})

it.each([null, 'true', 1])('rejects a non-boolean setupSnapshots capability (%s) on enrollment and claim', async setupSnapshots => {
  const { app } = harness()
  try {
    const report = { ...capabilities, capabilities: { ...capabilities.capabilities, setupSnapshots } }
    const created = await app.inject({ method: 'POST', url: '/api/v1/runner-enrollments', headers: actorHeaders })
    const enrolled = await app.inject({ method: 'POST', url: '/runner/v1/enroll', payload: { code: created.json().code, label: 'Invalid report', capabilities: report } })
    expect(enrolled.statusCode).toBe(400)
    const identity = await connect(app)
    const claim = await app.inject({ method: 'POST', url: '/runner/v1/jobs/claim', headers: { authorization: `Bearer ${identity.credential}` }, payload: { capabilities: report, waitMs: 0 } })
    expect(claim.statusCode).toBe(400)
  } finally { await app.close() }
})

it.each(snapshotCommands.flatMap(command => ['pending', 'leased', 'acknowledged'].map(state => ({ command, state }))))('skips unsupported $state $command jobs without blocking ordinary work or losing them', async ({ command, state }) => {
  const { app, service, repository, advance } = harness()
  const actor = { organizationId: 'org_01', userId: 'user_01' }
  try {
    const identity = await connect(app, snapshotCapabilities)
    const snapshot = await service.enqueueLibrary(actor, identity.deviceId, snapshotRequest(command))
    let initialLease = null
    if (state !== 'pending') {
      initialLease = await service.claimJob(identity.credential, { capabilities: snapshotCapabilities })
      expect(initialLease?.job.jobId).toBe(snapshot.jobId)
      if (state === 'acknowledged') await acknowledge(app, { authorization: `Bearer ${identity.credential}` }, snapshot.jobId, initialLease!.leaseId)
    }
    const before = await repository.jobStatus(actor.organizationId, snapshot.jobId)
    const ordinary = await service.enqueueLibrary(actor, identity.deviceId, { command: 'list_directories', args: { parent: null }, expectedDigest: null })
    const legacyClaim = await service.claimJob(identity.credential, { capabilities })
    expect(legacyClaim?.job.jobId).toBe(ordinary.jobId)
    expect(await repository.jobStatus(actor.organizationId, snapshot.jobId)).toEqual(before)
    const disabledClaim = await service.claimJob(identity.credential, { capabilities: { ...capabilities, capabilities: { ...capabilities.capabilities, setupSnapshots: false } } })
    expect(disabledClaim?.job.jobId).toBe(ordinary.jobId)
    expect(await repository.jobStatus(actor.organizationId, snapshot.jobId)).toEqual(before)
    if (initialLease) {
      const restored = await service.claimJob(identity.credential, { capabilities: snapshotCapabilities })
      expect(restored?.job.jobId).toBe(snapshot.jobId)
      expect(restored?.leaseId).toBe(initialLease.leaseId)
    }
    advance(1001)
    const restored = await service.claimJob(identity.credential, { capabilities: snapshotCapabilities })
    expect(restored?.job.jobId).toBe(snapshot.jobId)
  } finally { await app.close() }
})

it('delivers device library actions before any project is connected and isolates their results', async () => {
  const { app } = harness()
  const identity = await connect(app)
  const authorization = { authorization: `Bearer ${identity.credential}` }
  const payload = { command: 'list_directories', args: { parent: null }, expectedDigest: null }
  const queued = await app.inject({ method: 'POST', url: `/api/v1/runners/${identity.deviceId}/library`, headers: actorHeaders, payload })
  expect(queued.statusCode).toBe(200)
  const { jobId } = queued.json<{ jobId: string }>()
  const foreign = await app.inject({ method: 'POST', url: `/api/v1/runners/${identity.deviceId}/library`, headers: { ...actorHeaders, 'x-ahm-organization-id': 'foreign' }, payload })
  expect([403, 404]).toContain(foreign.statusCode)
  const claimed = await app.inject({ method: 'POST', url: '/runner/v1/jobs/claim', headers: authorization, payload: { capabilities, waitMs: 0 } })
  expect(claimed.statusCode).toBe(200)
  const lease = claimed.json<{ leaseId: string; job: { idempotencyKey: string; projectInstanceId: null } }>()
  expect(lease.job.projectInstanceId).toBeNull()
  await acknowledge(app, authorization, jobId, lease.leaseId)
  const result = { protocolVersion: '1.0', jobId, idempotencyKey: lease.job.idempotencyKey, organizationId: identity.organizationId, deviceId: identity.deviceId, projectInstanceId: null, result: { kind: 'libraryResponse', payload: { value: { children: [] } } } }
  const submitted = await app.inject({ method: 'POST', url: `/runner/v1/jobs/${jobId}/result`, headers: authorization, payload: { leaseId: lease.leaseId, result } })
  expect(submitted.json()).toEqual({ accepted: true, duplicate: false })
  const observed = await app.inject({ method: 'GET', url: `/api/v1/jobs/${jobId}`, headers: actorHeaders })
  expect(observed.json().result.result.payload.value).toEqual({ children: [] })
  const duplicate = await app.inject({ method: 'POST', url: `/runner/v1/jobs/${jobId}/result`, headers: authorization, payload: { leaseId: lease.leaseId, result } })
  expect(duplicate.json()).toEqual({ accepted: true, duplicate: true })
  await app.close()
})

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

it.each(['preview_setup_skill', 'snapshot_setup_skill'] as const)('persists a valid large %s manifest through HTTP result submission', async command => {
  const { app } = harness()
  try {
    const identity = await connect(app, snapshotCapabilities)
    const authorization = { authorization: `Bearer ${identity.credential}` }
    const contentDigest = `sha256:${'a'.repeat(64)}`
    // Three shared directories and these files fit the runner's 5,000-entry limit.
    // Quotes exercise JSON escaping at the portable artifact's 500-character path bound.
    const prefix = Array.from({ length: 3 }, () => '"'.repeat(120)).join('/')
    const snapshot: LibrarySetupSnapshot = {
      artifactId: `library-${'a'.repeat(64)}`, name: 'review', contentDigest,
      portableSource: null, supportedTools: ['codex'],
      files: [{ path: 'SKILL.md', size: 10 }, ...Array.from({ length: 4996 }, (_, index) => ({
        path: `${prefix}/${String(index).padStart(137, '"')}`, size: 0,
      }))],
    }
    expect(isLibrarySetupSnapshot(snapshot)).toBe(true)
    const queued = await app.inject({ method: 'POST', url: `/api/v1/runners/${identity.deviceId}/library`, headers: actorHeaders,
      payload: { command, args: { skillId: 'review' }, expectedDigest: command === 'snapshot_setup_skill' ? contentDigest : null } })
    expect(queued.statusCode).toBe(200)
    const { jobId } = queued.json<{ jobId: string }>()
    const claimed = await app.inject({ method: 'POST', url: '/runner/v1/jobs/claim', headers: authorization, payload: { capabilities: snapshotCapabilities, waitMs: 0 } })
    expect(claimed.statusCode).toBe(200)
    const lease = claimed.json<{ leaseId: string; job: { idempotencyKey: string } }>()
    await acknowledge(app, authorization, jobId, lease.leaseId)
    const result: ResultEnvelope = { protocolVersion: '1.0', jobId, idempotencyKey: lease.job.idempotencyKey,
      organizationId: identity.organizationId, deviceId: identity.deviceId, projectInstanceId: null,
      result: { kind: 'libraryResponse', payload: { value: snapshot } } }
    const payload = { leaseId: lease.leaseId, result }
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(1024 * 1024)
    const submitted = await app.inject({ method: 'POST', url: `/runner/v1/jobs/${jobId}/result`, headers: authorization, payload })
    expect(submitted.statusCode).toBe(200)
    expect(submitted.json()).toEqual({ accepted: true, duplicate: false })
    const observed = await app.inject({ method: 'GET', url: `/api/v1/jobs/${jobId}`, headers: actorHeaders })
    expect(observed.json().state).toBe('succeeded')
    expect(observed.json().result).toEqual(result)
  } finally { await app.close() }
})

it('uploads an artifact at its content and entry limits with escaped path metadata', async () => {
  const { app } = harness()
  try {
    const identity = await connect(app)
    const authorization = { authorization: `Bearer ${identity.credential}` }
    const directories = Array.from({ length: 3 }, (_, index) => Array.from({ length: index + 1 }, () => '"'.repeat(120)).join('/'))
    const entries: ArtifactBundleEntry[] = [
      ...directories.map(path => ({ path, kind: 'directory' as const, contentBase64: null })),
      { path: 'SKILL.md', kind: 'file', contentBase64: Buffer.alloc(10 * 1024 * 1024).toString('base64') },
      ...Array.from({ length: 4996 }, (_, index) => ({
        path: `${directories[2]}/${String(index).padStart(137, '"')}`, kind: 'file' as const, contentBase64: '',
      })),
    ]
    expect(entries).toHaveLength(5000)
    const bundle = { contentDigest: artifactDigest(entries), entries }
    expect(Buffer.byteLength(JSON.stringify(bundle))).toBeGreaterThan(15 * 1024 * 1024)
    const uploaded = await app.inject({ method: 'PUT', url: '/runner/v1/artifacts', headers: authorization, payload: bundle })
    expect(uploaded.statusCode).toBe(204)
    const retrieved = await app.inject({ method: 'GET', url: `/runner/v1/artifacts/${bundle.contentDigest}`, headers: authorization })
    expect(retrieved.statusCode).toBe(200)
    expect(retrieved.json()).toEqual(bundle)
  } finally { await app.close() }
})

it.each([{ method: 'POST' as const, url: '/runner/v1/jobs/oversized/result' }, { method: 'PUT' as const, url: '/runner/v1/artifacts' }])('rejects $url above the finite body limit before transport processing', async ({ method, url }) => {
  const { app } = harness()
  try {
    // A missing credential would fail in the route handler if parsing reached it.
    const response = await app.inject({ method, url, payload: { padding: 'x'.repeat(32 * 1024 * 1024) } })
    expect(response.statusCode).toBe(413)
    expect(response.json()).toEqual({ error: 'Request body is too large' })
  } finally { await app.close() }
})

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
    const secondLease = second.json<{ leaseId: string; job: { jobId: string } }>()
    expect(secondLease.leaseId).not.toBe(firstLease)
    await acknowledge(app, authorization, secondLease.job.jobId, secondLease.leaseId)
    advance(5 * 60_000)
    const resumed = await app.inject({
      method: 'POST',
      url: '/runner/v1/jobs/claim',
      headers: authorization,
      payload: { capabilities },
    })
    expect(resumed.statusCode).toBe(200)
    expect(resumed.json<{ leaseId: string }>().leaseId).not.toBe(secondLease.leaseId)

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

    const runningControl = await app.inject({
      method: 'POST',
      url: `/runner/v1/jobs/${jobId}/control`,
      headers: authorization,
      payload: { leaseId: lease.leaseId },
    })
    expect(runningControl.json()).toEqual({ cancelRequested: false })

    const wrongLease = await app.inject({
      method: 'POST',
      url: `/runner/v1/jobs/${jobId}/control`,
      headers: authorization,
      payload: { leaseId: 'wrong-lease' },
    })
    expect(wrongLease.statusCode).toBe(409)

    await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${jobId}/cancel`,
      headers: actorHeaders,
    })
    const cancelledControl = await app.inject({
      method: 'POST',
      url: `/runner/v1/jobs/${jobId}/control`,
      headers: authorization,
      payload: { leaseId: lease.leaseId },
    })
    expect(cancelledControl.json()).toEqual({ cancelRequested: true })
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
    const contentDigest = artifactDigest([{ path: 'SKILL.md', kind: 'file', contentBase64: btoa('# Shared') }])
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
