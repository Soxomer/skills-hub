import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { ResultEnvelope } from '@ahm/contracts'
import { newDb } from 'pg-mem'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'

import { createControlPlaneApp } from '../src/http.js'
import { InMemoryProjectRepository } from '../src/projects-memory.js'
import { PostgresProjectRepository } from '../src/projects-pg.js'
import { ProjectService } from '../src/projects.js'
import { InMemoryRunnerTransportRepository } from '../src/runner-transport-memory.js'
import { RunnerTransportService } from '../src/runner-transport.js'

const actor = { organizationId: 'org_01', userId: 'user_01' }
const actorHeaders = {
  'x-ahm-organization-id': actor.organizationId,
  'x-ahm-user-id': actor.userId,
}

function scanResult(projectId: string): ResultEnvelope {
  return {
    protocolVersion: '1.0',
    jobId: 'scan_01',
    idempotencyKey: 'scan-scan_01',
    organizationId: actor.organizationId,
    deviceId: 'device_01',
    projectInstanceId: 'instance_01',
    result: {
      kind: 'scanResult',
      payload: {
        projectId,
        discoveries: [
          {
            discoveryId: 'discovery_pdf',
            kind: 'skill',
            state: 'available',
            name: 'pdf',
            toolId: 'codex',
            portableSource: 'github:openai/skills/pdf@v1',
            contentDigest: 'sha256:pdf',
          },
          {
            discoveryId: 'discovery_local',
            kind: 'localContent',
            state: 'available',
            name: 'local-notes',
            toolId: 'claude-code',
            portableSource: null,
            contentDigest: 'sha256:local',
          },
          {
            discoveryId: 'discovery_conflict',
            kind: 'skill',
            state: 'conflict',
            name: 'conflict',
            toolId: 'codex',
            portableSource: 'github:example/conflict@v1',
            contentDigest: 'sha256:conflict',
          },
        ],
      },
    },
  }
}

function httpHarness() {
  let sequence = 0
  const repository = new InMemoryProjectRepository()
  const projects = new ProjectService(repository, {
    now: () => new Date('2026-09-01T12:00:00.000Z'),
    randomId: () => `id_${++sequence}`,
  })
  const transport = new RunnerTransportService(new InMemoryRunnerTransportRepository(), {
    serverUrl: 'https://hub.example.test',
  })
  return { app: createControlPlaneApp(transport, projects), repository }
}

describe('project and Default capture API', () => {
  it('creates and lists logical projects', async () => {
    const { app } = httpHarness()
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: actorHeaders,
      payload: { name: 'Skills Hub', repositoryIdentity: 'github:example/skills-hub' },
    })

    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({
      projectId: 'project_id_1',
      name: 'Skills Hub',
      repositoryIdentity: 'github:example/skills-hub',
      defaultRevision: null,
    })
    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: actorHeaders,
    })
    expect(listed.json()).toMatchObject({ projects: [{ projectId: 'project_id_1' }] })

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: actorHeaders,
      payload: { name: 'Skills Hub' },
    })
    expect(duplicate.statusCode).toBe(409)
    expect(duplicate.json()).toMatchObject({ code: 'projectNameTaken' })
    await app.close()
  })

  it('captures only eligible discoveries and makes retry idempotent', async () => {
    const { app, repository } = httpHarness()
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: actorHeaders,
      payload: { name: 'Project' },
    })
    const projectId = created.json<{ projectId: string }>().projectId
    repository.seedScanJob(actor.organizationId, projectId, {
      jobId: 'scan_01',
      state: 'succeeded',
      result: scanResult(projectId),
    })

    const capture = () =>
      app.inject({
        method: 'POST',
        url: `/api/v1/projects/${projectId}/default-revisions`,
        headers: actorHeaders,
        payload: {
          scanJobId: 'scan_01',
          includedDiscoveryIds: ['discovery_pdf', 'discovery_local'],
        },
      })
    const first = await capture()
    expect(first.statusCode).toBe(201)
    expect(first.json()).toMatchObject({
      projectId,
      created: true,
      defaultRevision: {
        revisionNumber: 1,
        sourceScanJobId: 'scan_01',
        itemCount: 2,
      },
    })
    const retry = await capture()
    expect(retry.statusCode).toBe(200)
    expect(retry.json()).toMatchObject({ created: false })

    const changedRetry = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/default-revisions`,
      headers: actorHeaders,
      payload: { scanJobId: 'scan_01', includedDiscoveryIds: ['discovery_pdf'] },
    })
    expect(changedRetry.statusCode).toBe(409)
    expect(changedRetry.json()).toMatchObject({ code: 'defaultAlreadyCaptured' })

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: actorHeaders,
    })
    expect(listed.json()).toMatchObject({
      projects: [{ defaultRevision: { itemCount: 2, sourceScanJobId: 'scan_01' } }],
    })
    await app.close()
  })

  it('rejects conflict discoveries and unfinished scans', async () => {
    const { app, repository } = httpHarness()
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: actorHeaders,
      payload: { name: 'Project' },
    })
    const projectId = created.json<{ projectId: string }>().projectId
    repository.seedScanJob(actor.organizationId, projectId, {
      jobId: 'scan_01',
      state: 'succeeded',
      result: scanResult(projectId),
    })
    const conflict = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/default-revisions`,
      headers: actorHeaders,
      payload: { scanJobId: 'scan_01', includedDiscoveryIds: ['discovery_conflict'] },
    })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json()).toMatchObject({ code: 'discoveryNotEligible' })

    repository.seedScanJob(actor.organizationId, projectId, {
      jobId: 'scan_pending',
      state: 'leased',
      result: null,
    })
    const pending = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/default-revisions`,
      headers: actorHeaders,
      payload: { scanJobId: 'scan_pending', includedDiscoveryIds: [] },
    })
    expect(pending.statusCode).toBe(409)
    expect(pending.json()).toMatchObject({ code: 'scanNotReady' })
    await app.close()
  })
})

describe('Postgres Default capture persistence', () => {
  it('stores portable provenance without a runner-local path', async () => {
    const database = newDb({ autoCreateForeignKeyIndices: true })
    for (const migrationName of [
      '0001_control_plane.sql',
      '0002_runner_transport.sql',
      '0003_default_capture.sql',
      '0004_runner_delivery.sql',
      '0005_project_operation_singleflight.sql',
      '0006_runner_job_setup_revision.sql',
      '0007_custom_setup_name_uniqueness.sql',
    ]) {
      const path = fileURLToPath(new URL(`../migrations/${migrationName}`, import.meta.url))
      database.public.none(readFileSync(path, 'utf8'))
    }
    const adapter = database.adapters.createPg()
    const pool = new adapter.Pool() as unknown as Pool
    await pool.query(`
      INSERT INTO organizations (id, name, created_at)
      VALUES ('org_01', 'Example', '2026-09-01T00:00:00Z');
      INSERT INTO users (id, display_name, created_at)
      VALUES ('user_01', 'Owner', '2026-09-01T00:00:00Z');
    `)
    const projects = new ProjectService(new PostgresProjectRepository(pool), {
      now: () => new Date('2026-09-01T12:00:00.000Z'),
      randomId: () => 'pg_01',
    })
    const project = await projects.createProject(actor, { name: 'Portable project' })
    const result = scanResult(project.projectId)
    await pool.query(
      `INSERT INTO runner_devices
       (id, organization_id, label, credential_hash, status, enrolled_at)
       VALUES ('device_01', 'org_01', 'Runner', 'hash', 'active', $1);
       INSERT INTO project_instances
       (id, organization_id, project_id, device_id, registered_at)
       VALUES ('instance_01', 'org_01', $2, 'device_01', $1);
       INSERT INTO runner_jobs
       (id, organization_id, device_id, project_instance_id, protocol_version,
        idempotency_key, job_kind, payload, state, issued_at, expires_at,
        completed_at, result_json, result_digest)
       VALUES ('scan_01', 'org_01', 'device_01', 'instance_01', '1.0',
               'scan-scan_01', 'scanProject', $3::jsonb, 'succeeded', $1, $4,
               $1, $5::jsonb, 'digest')`,
      [
        '2026-09-01T12:00:00.000Z',
        project.projectId,
        JSON.stringify({ projectId: project.projectId, includeUnmanaged: true }),
        '2026-09-01T12:05:00.000Z',
        JSON.stringify(result),
      ],
    )

    const captured = await projects.captureDefault(actor, project.projectId, {
      scanJobId: 'scan_01',
      includedDiscoveryIds: ['discovery_pdf'],
    })
    expect(captured.defaultRevision).toMatchObject({ itemCount: 1, sourceScanJobId: 'scan_01' })
    const stored = await pool.query<{ artifact_reference: Record<string, unknown> }>(
      `SELECT artifact_reference FROM setup_revision_items`,
    )
    expect(stored.rows[0]?.artifact_reference).toEqual({
      portableSource: 'github:openai/skills/pdf@v1',
      contentDigest: 'sha256:pdf',
    })
    expect(
      (
        await pool.query<{ normalized_name: string }>(
          `SELECT normalized_name FROM setup_name_claims WHERE organization_id = 'org_01'`,
        )
      ).rows,
    ).toEqual([
      { normalized_name: `default / portable project / ${project.projectId}` },
    ])
    expect(JSON.stringify(stored.rows[0])).not.toMatch(/path/i)
    await pool.end()
  })
})
