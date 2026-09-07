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
    '0005_project_operation_singleflight.sql',
    '0006_runner_job_setup_revision.sql',
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
  it('admits one active Setup operation per project checkout', async () => {
    const { app, pool } = await harness()
    const admitted = await app.inject({
      method: 'POST',
      url: '/api/v1/project-instances/instance_01/plan',
      headers: actorHeaders,
      payload: { setupRevisionId: 'revision_team' },
    })
    expect(admitted.statusCode).toBe(200)
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/v1/project-instances/instance_01/plan',
      headers: actorHeaders,
      payload: { setupRevisionId: 'revision_default' },
    })
    expect(rejected.statusCode).toBe(409)
    expect(rejected.json()).toMatchObject({
      code: 'projectOperationInProgress',
      activeOperation: {
        jobId: admitted.json<{ jobId: string }>().jobId,
        kind: 'planSetup',
        state: 'pending',
        cancelRequested: false,
      },
    })

    const activeJobId = admitted.json<{ jobId: string }>().jobId
    const operations = await app.inject({
      method: 'GET',
      url: '/api/v1/project-instances/instance_01/operations',
      headers: actorHeaders,
    })
    expect(operations.json()).toMatchObject({
      activeOperation: {
        jobId: activeJobId,
        kind: 'planSetup',
        state: 'pending',
        setupRevisionId: expect.stringMatching(/^revision_(default|team)$/),
        cancelRequested: false,
      },
    })

    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${activeJobId}/cancel`,
      headers: actorHeaders,
    })
    expect(cancelled.statusCode).toBe(204)
    const afterCancellation = await app.inject({
      method: 'GET',
      url: '/api/v1/project-instances/instance_01/operations',
      headers: actorHeaders,
    })
    expect(afterCancellation.json()).toMatchObject({ activeOperation: null })

    const replacement = await app.inject({
      method: 'POST',
      url: '/api/v1/project-instances/instance_01/plan',
      headers: actorHeaders,
      payload: { setupRevisionId: 'revision_team' },
    })
    expect(replacement.statusCode).toBe(200)
    await app.close()
    await pool.end()
  })

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

    const reviewState = await app.inject({
      method: 'GET',
      url: '/api/v1/project-instances/instance_01/operations',
      headers: actorHeaders,
    })
    expect(reviewState.json()).toMatchObject({
      reviewedPlan: {
        jobId: planJobId,
        plan: { setupRevisionId: 'revision_team', planDigest },
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
    const applyingState = await app.inject({
      method: 'GET',
      url: '/api/v1/project-instances/instance_01/operations',
      headers: actorHeaders,
    })
    expect(applyingState.json()).toMatchObject({ reviewedPlan: null })
    expect(
      (
        await pool.query<{ expires_at: Date }>(
          `SELECT expires_at FROM runner_jobs WHERE id = $1`,
          [applyJobId],
        )
      ).rows[0]?.expires_at.toISOString(),
    ).toBe('2026-09-02T10:00:30.000Z')
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

    const appliedHistory = await app.inject({
      method: 'GET',
      url: '/api/v1/project-instances/instance_01/operations',
      headers: actorHeaders,
    })
    expect(appliedHistory.statusCode).toBe(200)
    expect(appliedHistory.json()).toMatchObject({
      assignedSetupRevisionId: 'revision_team',
      materializedSetupRevisionId: 'revision_team',
      health: 'current',
      operations: [
        {
          jobId: applyJobId,
          kind: 'applyPlan',
          state: 'succeeded',
          operationId: 'operation_01',
          recoverability: 'rollbackAvailable',
        },
      ],
    })

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
    const rolledBackHistory = await app.inject({
      method: 'GET',
      url: '/api/v1/project-instances/instance_01/operations',
      headers: actorHeaders,
    })
    expect(rolledBackHistory.json()).toMatchObject({
      assignedSetupRevisionId: 'revision_default',
      materializedSetupRevisionId: 'revision_default',
      health: 'current',
      operations: [
        {
          kind: 'rollbackOperation',
          state: 'succeeded',
          operationId: 'operation_01',
          setupRevisionId: 'revision_default',
        },
        { kind: 'applyPlan', state: 'succeeded' },
      ],
    })
    await app.close()
    await pool.end()
  })

  it('records a cancelled-and-restored apply without changing the assignment', async () => {
    const { app, pool, transport } = await harness()
    const jobId = 'job_cancelled_apply'
    await pool.query(
      `INSERT INTO runner_jobs
       (id, organization_id, device_id, project_instance_id, protocol_version,
        idempotency_key, job_kind, payload, state, issued_at, expires_at)
       VALUES ($1, 'org_01', 'device_01', 'instance_01', '1.0', 'cancelled-apply',
        'applyPlan', $2::jsonb, 'pending', $3, $4)`,
      [
        jobId,
        JSON.stringify({
          projectId: 'project_01',
          revision: {
            setupId: 'setup_team',
            setupRevisionId: 'revision_team',
            revisionNumber: 1,
            items: [],
          },
          approval: {
            approvalId: 'approval_cancelled',
            organizationId: 'org_01',
            projectInstanceId: 'instance_01',
            setupRevisionId: 'revision_team',
            planDigest: `sha256:${'d'.repeat(64)}`,
            approvedBy: 'user_01',
            approvedAt: now,
            expiresAt: '2026-09-02T10:00:30.000Z',
          },
        }),
        now,
        '2026-09-02T10:00:30.000Z',
      ],
    )
    const lease = await claim(pool, jobId)
    await acknowledge(transport, jobId, lease.leaseId)
    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${jobId}/cancel`,
      headers: actorHeaders,
    })
    expect(cancelled.statusCode).toBe(204)
    await expect(
      transport.jobControl(credential, jobId, { leaseId: lease.leaseId }),
    ).resolves.toEqual({ cancelRequested: true })

    await submit(transport, lease.leaseId, {
      protocolVersion: '1.0',
      jobId,
      idempotencyKey: lease.job.idempotencyKey,
      organizationId: 'org_01',
      deviceId: 'device_01',
      projectInstanceId: 'instance_01',
      result: {
        kind: 'cancellationReceipt',
        payload: {
          projectId: 'project_01',
          operationId: 'operation_cancelled',
          outcome: 'cancelledAndRestored',
          recoverability: 'notNeeded',
          actionsApplied: 1,
          completedAt: now,
        },
      },
    })

    const status = await app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${jobId}`,
      headers: actorHeaders,
    })
    expect(status.json()).toMatchObject({ state: 'cancelled', cancelRequested: true })
    const assignment = await pool.query<{ setup_revision_id: string }>(
      `SELECT setup_revision_id FROM project_assignments WHERE project_id = 'project_01'`,
    )
    expect(assignment.rows[0]?.setup_revision_id).toBe('revision_default')
    const history = await app.inject({
      method: 'GET',
      url: '/api/v1/project-instances/instance_01/operations',
      headers: actorHeaders,
    })
    expect(history.json()).toMatchObject({
      activeOperation: null,
      operations: [
        {
          jobId,
          state: 'cancelled',
          operationId: 'operation_cancelled',
          outcome: 'cancelledAndRestored',
          recoverability: 'notNeeded',
        },
      ],
    })

    const completedFirstJobId = 'job_completed_before_cancel_observed'
    await pool.query(
      `INSERT INTO runner_jobs
       (id, organization_id, device_id, project_instance_id, protocol_version,
        idempotency_key, job_kind, payload, state, issued_at, expires_at)
       SELECT $1, organization_id, device_id, project_instance_id, protocol_version,
              'completed-before-cancel-observed', job_kind, payload, 'pending', issued_at, expires_at
       FROM runner_jobs WHERE id = $2`,
      [completedFirstJobId, jobId],
    )
    const completedFirstLease = await claim(pool, completedFirstJobId)
    await acknowledge(transport, completedFirstJobId, completedFirstLease.leaseId)
    await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${completedFirstJobId}/cancel`,
      headers: actorHeaders,
    })
    await submit(transport, completedFirstLease.leaseId, {
      protocolVersion: '1.0',
      jobId: completedFirstJobId,
      idempotencyKey: completedFirstLease.job.idempotencyKey,
      organizationId: 'org_01',
      deviceId: 'device_01',
      projectInstanceId: 'instance_01',
      result: {
        kind: 'applyReceipt',
        payload: {
          projectId: 'project_01',
          operationId: 'operation_completed_first',
          setupRevisionId: 'revision_team',
          planDigest: `sha256:${'d'.repeat(64)}`,
          outcome: 'applied',
          recoverability: 'rollbackAvailable',
          actionsApplied: 1,
          completedAt: now,
        },
      },
    })
    const completedFirstStatus = await app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${completedFirstJobId}`,
      headers: actorHeaders,
    })
    expect(completedFirstStatus.json()).toMatchObject({
      state: 'succeeded',
      cancelRequested: true,
    })
    const completedFirstAssignment = await pool.query<{ setup_revision_id: string }>(
      `SELECT setup_revision_id FROM project_assignments WHERE project_id = 'project_01'`,
    )
    expect(completedFirstAssignment.rows[0]?.setup_revision_id).toBe('revision_team')
    await app.close()
    await pool.end()
  })

  it('derives health only from a newer plan for the assigned Setup', async () => {
    const { app, pool } = await harness()
    const result = (
      jobId: string,
      setupRevisionId: string,
      change: 'add' | 'unchanged',
      conflicts: string[] = [],
      metadataOnly = false,
    ): ResultEnvelope => ({
      protocolVersion: '1.0',
      jobId,
      idempotencyKey: `idem-${jobId}`,
      organizationId: 'org_01',
      deviceId: 'device_01',
      projectInstanceId: 'instance_01',
      result: {
        kind: 'planResult',
        payload: {
          projectId: 'project_01',
          plan: {
            setupRevisionId,
            planDigest: `sha256:${jobId.endsWith('team') ? 'a' : change === 'add' ? 'b' : 'c'}`.padEnd(71, jobId.endsWith('team') ? 'a' : change === 'add' ? 'b' : 'c'),
            conflicts,
            actions: [
              {
                actionId: `action_${jobId}`,
                kind: 'link',
                change,
                ...(metadataOnly ? { metadataOnly: true } : {}),
                artifactId: 'artifact_default',
                destination: {
                  toolId: 'codex',
                  projectRelativePath: '.agents/skills/default',
                },
              },
            ],
          },
        },
      },
    })
    const insertPlan = async (jobId: string, completedAt: string, envelope: ResultEnvelope) => {
      const setupRevisionId =
        envelope.result.kind === 'planResult'
          ? envelope.result.payload.plan.setupRevisionId
          : null
      await pool.query(
        `INSERT INTO runner_jobs
         (id, organization_id, device_id, project_instance_id, protocol_version,
          idempotency_key, job_kind, payload, setup_revision_id, state, issued_at, expires_at, completed_at,
          result_json, result_digest)
         VALUES ($1, 'org_01', 'device_01', 'instance_01', '1.0', $2, 'planSetup',
          $3::jsonb, $4, 'succeeded', $5, $6, $5, $7::jsonb, $8)`,
        [
          jobId,
          envelope.idempotencyKey,
          JSON.stringify({ projectId: 'project_01', revision: { setupRevisionId } }),
          setupRevisionId,
          completedAt,
          '2026-09-02T11:00:00.000Z',
          JSON.stringify(envelope),
          `sha256:${'f'.repeat(64)}`,
        ],
      )
    }

    await insertPlan(
      'job_plan_team',
      '2026-09-02T10:01:00.000Z',
      result('job_plan_team', 'revision_team', 'add', ['unmanaged target']),
    )
    const alternative = await app.inject({
      method: 'GET',
      url: '/api/v1/project-instances/instance_01/operations',
      headers: actorHeaders,
    })
    expect(alternative.json()).toMatchObject({ health: 'unknown' })

    await insertPlan(
      'job_plan_default_change',
      '2026-09-02T10:02:00.000Z',
      result('job_plan_default_change', 'revision_default', 'add'),
    )
    const drifted = await app.inject({
      method: 'GET',
      url: '/api/v1/project-instances/instance_01/operations',
      headers: actorHeaders,
    })
    expect(drifted.json()).toMatchObject({ health: 'drifted' })

    await insertPlan(
      'job_plan_team_later',
      '2026-09-02T10:02:30.000Z',
      result('job_plan_team_later', 'revision_team', 'add', ['unmanaged target']),
    )
    const driftPreserved = await app.inject({
      method: 'GET',
      url: '/api/v1/project-instances/instance_01/operations',
      headers: actorHeaders,
    })
    expect(driftPreserved.json()).toMatchObject({ health: 'drifted' })

    await insertPlan(
      'job_plan_default_metadata',
      '2026-09-02T10:02:45.000Z',
      result('job_plan_default_metadata', 'revision_default', 'unchanged', [], true),
    )
    const metadataDrift = await app.inject({
      method: 'GET',
      url: '/api/v1/project-instances/instance_01/operations',
      headers: actorHeaders,
    })
    expect(metadataDrift.json()).toMatchObject({ health: 'drifted' })

    await insertPlan(
      'job_plan_default_current',
      '2026-09-02T10:03:00.000Z',
      result('job_plan_default_current', 'revision_default', 'unchanged'),
    )
    const current = await app.inject({
      method: 'GET',
      url: '/api/v1/project-instances/instance_01/operations',
      headers: actorHeaders,
    })
    expect(current.json()).toMatchObject({
      health: 'current',
      materializedSetupRevisionId: 'revision_default',
    })

    const failedPlan: ResultEnvelope = {
      protocolVersion: '1.0',
      jobId: 'job_plan_failed_later',
      idempotencyKey: 'idem-job_plan_failed_later',
      organizationId: 'org_01',
      deviceId: 'device_01',
      projectInstanceId: 'instance_01',
      result: {
        kind: 'error',
        payload: {
          code: 'operationFailed',
          message: 'plan failed',
          retryable: true,
          recoverability: 'notNeeded',
        },
      },
    }
    await pool.query(
      `INSERT INTO runner_jobs
       (id, organization_id, device_id, project_instance_id, protocol_version,
        idempotency_key, job_kind, payload, setup_revision_id, state, issued_at, expires_at,
        completed_at, result_json, result_digest)
       VALUES ($1, 'org_01', 'device_01', 'instance_01', '1.0', $2, 'planSetup',
        $3::jsonb, 'revision_team', 'failed', $4, $5, $4, $6::jsonb, $7)`,
      [
        failedPlan.jobId,
        failedPlan.idempotencyKey,
        JSON.stringify({ projectId: 'project_01', revision: { setupRevisionId: 'revision_team' } }),
        '2026-09-02T10:04:00.000Z',
        '2026-09-02T11:00:00.000Z',
        JSON.stringify(failedPlan),
        `sha256:${'e'.repeat(64)}`,
      ],
    )
    const superseded = await app.inject({
      method: 'GET',
      url: '/api/v1/project-instances/instance_01/operations',
      headers: actorHeaders,
    })
    expect(superseded.json()).toMatchObject({ health: 'current', reviewedPlan: null })
    const applySuperseded = await app.inject({
      method: 'POST',
      url: '/api/v1/project-instances/instance_01/apply',
      headers: actorHeaders,
      payload: {
        planJobId: 'job_plan_default_current',
        planDigest: `sha256:${'c'.repeat(64)}`,
      },
    })
    expect(applySuperseded.statusCode).toBe(409)
    expect(applySuperseded.json()).toMatchObject({ code: 'planDigestMismatch' })
    await app.close()
    await pool.end()
  })

  it('surfaces a partially failed local mutation as manual recovery work', async () => {
    const { app, pool } = await harness()
    const failedResult: ResultEnvelope = {
      protocolVersion: '1.0',
      jobId: 'job_failed_apply',
      idempotencyKey: 'apply-failure',
      organizationId: 'org_01',
      deviceId: 'device_01',
      projectInstanceId: 'instance_01',
      result: {
        kind: 'error',
        payload: {
          code: 'operationFailed',
          message: 'apply failed after one local change',
          retryable: false,
          recoverability: 'manualIntervention',
        },
      },
    }
    await pool.query(
      `INSERT INTO runner_jobs
       (id, organization_id, device_id, project_instance_id, protocol_version,
        idempotency_key, job_kind, payload, state, issued_at, expires_at, completed_at,
        result_json, result_digest)
       VALUES ($1, 'org_01', 'device_01', 'instance_01', '1.0', 'apply-failure',
        'applyPlan', $2::jsonb, 'failed', $3, $4, $3, $5::jsonb, $6)`,
      [
        failedResult.jobId,
        JSON.stringify({
          projectId: 'project_01',
          revision: {
            setupId: 'setup_team',
            setupRevisionId: 'revision_team',
            revisionNumber: 1,
            items: [],
          },
          approval: {
            approvalId: 'approval_failed',
            organizationId: 'org_01',
            projectInstanceId: 'instance_01',
            setupRevisionId: 'revision_team',
            planDigest: `sha256:${'d'.repeat(64)}`,
            approvedBy: 'user_01',
            approvedAt: now,
            expiresAt: '2026-09-02T10:00:30.000Z',
          },
        }),
        now,
        '2026-09-02T10:00:30.000Z',
        JSON.stringify(failedResult),
        `sha256:${'f'.repeat(64)}`,
      ],
    )

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/project-instances/instance_01/operations',
      headers: actorHeaders,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      assignedSetupRevisionId: 'revision_default',
      materializedSetupRevisionId: null,
      health: 'attention',
      operations: [
        {
          jobId: 'job_failed_apply',
          state: 'failed',
          setupRevisionId: 'revision_team',
          errorCode: 'operationFailed',
          retryable: false,
          recoverability: 'manualIntervention',
        },
      ],
    })
    await app.close()
    await pool.end()
  })
})
