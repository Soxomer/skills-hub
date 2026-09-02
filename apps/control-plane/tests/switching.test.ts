import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { JobEnvelope, ResultEnvelope, RunnerCapabilityReport } from '@ahm/contracts'
import { newDb } from 'pg-mem'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'

import { createControlPlaneApp } from '../src/http.js'
import { InMemoryProjectRepository } from '../src/projects-memory.js'
import { ProjectService } from '../src/projects.js'
import { PostgresRunnerTransportRepository } from '../src/runner-transport-pg.js'
import { RunnerTransportService } from '../src/runner-transport.js'
import { PostgresSwitchingRepository } from '../src/switching-pg.js'
import { SwitchingService } from '../src/switching.js'

const now = '2026-09-02T10:00:00.000Z'
const actorHeaders = {
  'x-ahm-organization-id': 'org_01',
  'x-ahm-user-id': 'user_01',
}
const credential = 'runner-secret'
const capabilities: RunnerCapabilityReport = {
  protocolVersion: '1.0',
  supportedProtocolVersions: ['1.0'],
  runnerVersion: '0.1.0',
  capabilities: {
    scanProject: true,
    planSetup: true,
    applyPlan: true,
    rollbackOperation: true,
    supportedTools: ['codex'],
  },
}

async function harness() {
  const database = newDb({ autoCreateForeignKeyIndices: true })
  for (const migrationName of [
    '0001_control_plane.sql',
    '0002_runner_transport.sql',
    '0003_default_capture.sql',
    '0004_runner_delivery.sql',
  ]) {
    const path = fileURLToPath(new URL(`../migrations/${migrationName}`, import.meta.url))
    database.public.none(readFileSync(path, 'utf8'))
  }
  const adapter = database.adapters.createPg()
  const pool = new adapter.Pool() as unknown as Pool
  await pool.query(
    `INSERT INTO organizations (id, name, created_at)
     VALUES ('org_01', 'Example', $1);
     INSERT INTO users (id, display_name, created_at)
     VALUES ('user_01', 'Owner', $1);
     INSERT INTO projects (id, organization_id, name, created_at, updated_at)
     VALUES ('project_01', 'org_01', 'Project', $1, $1);
     INSERT INTO runner_devices
       (id, organization_id, label, credential_hash, status, enrolled_at, last_seen_at,
        runner_version, supported_protocol_versions, capabilities)
     VALUES ('device_01', 'org_01', 'Runner', $2, 'active', $1, $1,
             '0.1.0', $3::jsonb, $4::jsonb);
     INSERT INTO project_instances
       (id, organization_id, project_id, device_id, registered_at, last_seen_at)
     VALUES ('instance_01', 'org_01', 'project_01', 'device_01', $1, $1);
     INSERT INTO setups
       (id, organization_id, name, kind, default_project_id, created_by, created_at, updated_at)
     VALUES
       ('setup_default', 'org_01', 'Default', 'default', 'project_01', 'user_01', $1, $1),
       ('setup_team', 'org_01', 'Team', 'custom', NULL, 'user_01', $1, $1);
     INSERT INTO setup_revisions
       (id, organization_id, setup_id, revision_number, created_by, created_at)
     VALUES
       ('revision_default', 'org_01', 'setup_default', 1, 'user_01', $1),
       ('revision_team', 'org_01', 'setup_team', 1, 'user_01', $1);
     INSERT INTO setup_revision_items
       (organization_id, setup_revision_id, artifact_id, artifact_kind,
        artifact_reference, tool_id, target_name)
     VALUES
       ('org_01', 'revision_default', 'artifact_default', 'skill', $5::jsonb, 'codex', 'default'),
       ('org_01', 'revision_team', 'artifact_team', 'skill', $6::jsonb, 'codex', 'team');
     INSERT INTO project_assignments
       (organization_id, project_id, setup_revision_id, assigned_by, assigned_at)
     VALUES ('org_01', 'project_01', 'revision_default', 'user_01', $1)`,
    [
      now,
      createHash('sha256').update(credential).digest('hex'),
      JSON.stringify(['1.0']),
      JSON.stringify(capabilities.capabilities),
      JSON.stringify({ portableSource: null, contentDigest: `sha256:${'a'.repeat(64)}` }),
      JSON.stringify({ portableSource: null, contentDigest: `sha256:${'b'.repeat(64)}` }),
    ],
  )
  let sequence = 0
  const transport = new RunnerTransportService(new PostgresRunnerTransportRepository(pool), {
    serverUrl: 'https://hub.example.test',
    now: () => new Date(now),
    randomId: () => `transport_${++sequence}`,
  })
  const switching = new SwitchingService(new PostgresSwitchingRepository(pool), transport, {
    now: () => new Date(now),
    randomId: () => `switch_${++sequence}`,
  })
  const app = createControlPlaneApp(
    transport,
    new ProjectService(new InMemoryProjectRepository()),
    switching,
  )
  return { app, pool, transport }
}

async function claim(
  pool: Pool,
  jobId: string,
) {
  const leaseId = `lease_${jobId}`
  const result = await pool.query<{
    protocol_version: '1.0'
    idempotency_key: string
    organization_id: string
    device_id: string
    project_instance_id: string
    issued_at: Date
    expires_at: Date
    job_kind: JobEnvelope['job']['kind']
    payload: JobEnvelope['job']['payload'] | string
  }>(
    `UPDATE runner_jobs
     SET state = 'leased', lease_id = $1, lease_expires_at = $2
     WHERE id = $3
     RETURNING protocol_version, idempotency_key, organization_id, device_id,
               project_instance_id, issued_at, expires_at, job_kind, payload`,
    [leaseId, '2026-09-02T10:01:00.000Z', jobId],
  )
  const row = result.rows[0]
  expect(row).toBeDefined()
  return {
    leaseId,
    job: {
      protocolVersion: row!.protocol_version,
      jobId,
      idempotencyKey: row!.idempotency_key,
      organizationId: row!.organization_id,
      deviceId: row!.device_id,
      projectInstanceId: row!.project_instance_id,
      issuedAt: row!.issued_at.toISOString(),
      expiresAt: row!.expires_at.toISOString(),
      job: {
        kind: row!.job_kind,
        payload:
          typeof row!.payload === 'string'
            ? (JSON.parse(row!.payload) as JobEnvelope['job']['payload'])
            : row!.payload,
      } as JobEnvelope['job'],
    },
  }
}

async function acknowledge(
  transport: RunnerTransportService,
  jobId: string,
  leaseId: string,
) {
  await expect(
    transport.acknowledgeJob(credential, jobId, {
      leaseId,
      requestDigest: `sha256:${'c'.repeat(64)}`,
    }),
  ).resolves.toEqual({ accepted: true, duplicate: false })
}

async function submit(
  transport: RunnerTransportService,
  leaseId: string,
  result: ResultEnvelope,
) {
  await expect(
    transport.submitResult(credential, result.jobId, { leaseId, result }),
  ).resolves.toEqual({
    accepted: true,
    duplicate: false,
  })
}

describe('Setup switching', () => {
  it('binds approval to the reviewed digest, persists the receipt, and restores assignment', async () => {
    const { app, pool, transport } = await harness()
    const state = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/project_01/setup-revisions',
      headers: actorHeaders,
    })
    expect(state.json()).toMatchObject({
      defaultSetupRevisionId: 'revision_default',
      assignedSetupRevisionId: 'revision_default',
      revisions: [{ name: 'Default' }, { name: 'Team' }],
    })

    const requested = await app.inject({
      method: 'POST',
      url: '/api/v1/project-instances/instance_01/plan',
      headers: actorHeaders,
      payload: { setupRevisionId: 'revision_team' },
    })
    expect(requested.statusCode).toBe(200)
    const planJobId = requested.json<{ jobId: string }>().jobId
    const planLease = await claim(pool, planJobId)
    expect(planLease.job.job).toMatchObject({
      kind: 'planSetup',
      payload: { revision: { setupRevisionId: 'revision_team' } },
    })
    await acknowledge(transport, planJobId, planLease.leaseId)
    const planDigest = `sha256:${'d'.repeat(64)}`
    await submit(transport, planLease.leaseId, {
      protocolVersion: '1.0',
      jobId: planJobId,
      idempotencyKey: planLease.job.idempotencyKey,
      organizationId: 'org_01',
      deviceId: 'device_01',
      projectInstanceId: 'instance_01',
      result: {
        kind: 'planResult',
        payload: {
          projectId: 'project_01',
          plan: {
            setupRevisionId: 'revision_team',
            planDigest,
            conflicts: [],
            actions: [
              {
                actionId: 'action_01',
                kind: 'link',
                artifactId: 'artifact_team',
                destination: { toolId: 'codex', projectRelativePath: '.codex/skills/team' },
              },
            ],
          },
        },
      },
    })

    const stale = await app.inject({
      method: 'POST',
      url: '/api/v1/project-instances/instance_01/apply',
      headers: actorHeaders,
      payload: { planJobId, planDigest: `sha256:${'e'.repeat(64)}` },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toMatchObject({ code: 'planDigestMismatch' })

    const applied = await app.inject({
      method: 'POST',
      url: '/api/v1/project-instances/instance_01/apply',
      headers: actorHeaders,
      payload: { planJobId, planDigest },
    })
    expect(applied.statusCode).toBe(200)
    const applyJobId = applied.json<{ jobId: string; approvalId: string }>().jobId
    const repeated = await app.inject({
      method: 'POST',
      url: '/api/v1/project-instances/instance_01/apply',
      headers: actorHeaders,
      payload: { planJobId, planDigest },
    })
    expect(repeated.json<{ jobId: string }>().jobId).toBe(applyJobId)

    const applyLease = await claim(pool, applyJobId)
    await acknowledge(transport, applyJobId, applyLease.leaseId)
    await submit(transport, applyLease.leaseId, {
      protocolVersion: '1.0',
      jobId: applyJobId,
      idempotencyKey: applyLease.job.idempotencyKey,
      organizationId: 'org_01',
      deviceId: 'device_01',
      projectInstanceId: 'instance_01',
      result: {
        kind: 'applyReceipt',
        payload: {
          projectId: 'project_01',
          operationId: 'operation_01',
          setupRevisionId: 'revision_team',
          planDigest,
          outcome: 'applied',
          recoverability: 'rollbackAvailable',
          actionsApplied: 1,
          completedAt: now,
        },
      },
    })
    expect(
      (
        await pool.query<{ setup_revision_id: string }>(
          `SELECT setup_revision_id FROM project_assignments WHERE project_id = 'project_01'`,
        )
      ).rows[0]?.setup_revision_id,
    ).toBe('revision_team')

    const rollback = await app.inject({
      method: 'POST',
      url: '/api/v1/project-instances/instance_01/rollback',
      headers: actorHeaders,
      payload: { operationId: 'operation_01' },
    })
    expect(rollback.statusCode).toBe(200)
    const rollbackJobId = rollback.json<{ jobId: string }>().jobId
    const rollbackLease = await claim(pool, rollbackJobId)
    await acknowledge(transport, rollbackJobId, rollbackLease.leaseId)
    await submit(transport, rollbackLease.leaseId, {
      protocolVersion: '1.0',
      jobId: rollbackJobId,
      idempotencyKey: rollbackLease.job.idempotencyKey,
      organizationId: 'org_01',
      deviceId: 'device_01',
      projectInstanceId: 'instance_01',
      result: {
        kind: 'rollbackReceipt',
        payload: {
          projectId: 'project_01',
          operationId: 'operation_01',
          restoredSetupRevisionId: 'revision_default',
          outcome: 'rolledBack',
          recoverability: 'notNeeded',
          completedAt: now,
        },
      },
    })
    expect(
      (
        await pool.query<{ setup_revision_id: string }>(
          `SELECT setup_revision_id FROM project_assignments WHERE project_id = 'project_01'`,
        )
      ).rows[0]?.setup_revision_id,
    ).toBe('revision_default')
    expect(
      (
        await pool.query<{ outcome: string }>(
          `SELECT outcome FROM operation_receipts WHERE operation_id = 'operation_01'`,
        )
      ).rows[0]?.outcome,
    ).toBe('rolledBack')
    await app.close()
    await pool.end()
  })
})
