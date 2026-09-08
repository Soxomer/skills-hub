import { PROTOCOL_VERSION } from '@ahm/contracts'
import type {
  ArtifactBundle,
  JobEnvelope,
  LeasedRunnerJob,
  ProtocolVersion,
  RegisterProjectInstanceRequest,
  ResultEnvelope,
  RunnerCapabilityReport,
  RunnerJobStatusResponse,
  RunnerJob,
  RunnerStatusResponse,
} from '@ahm/contracts'
import type { Pool, PoolClient, QueryResultRow } from 'pg'

import type {
  JobCompletion,
  BrowserRunnerRepository,
  RequestActor,
  JobAcknowledgement,
  JobControlCheck,
  ProjectInstanceRoute,
  RunnerAuthentication,
  RunnerDeviceRegistration,
  RunnerEnrollmentRecord,
  RunnerTransportRepository,
} from './runner-transport.js'
import { RunnerTransportError } from './runner-transport.js'
import { membershipAllows, type BrowserAccess, type MembershipRole } from './development-auth.js'

interface EnrollmentRow extends QueryResultRow {
  id: string
  organization_id: string
  created_by: string
  code_hash: string
  state: RunnerEnrollmentRecord['state']
  claimed_device_id: string | null
  created_at: Date
  expires_at: Date
  claimed_at: Date | null
}

interface AuthenticationRow extends QueryResultRow {
  organization_id: string
  device_id: string
  status: RunnerAuthentication['status']
}

interface RunnerStatusRow extends QueryResultRow {
  id: string
  label: string
  status: RunnerStatusResponse['status']
  enrolled_at: Date
  last_seen_at: Date | null
  runner_version: string | null
  supported_protocol_versions: ProtocolVersion[] | null
  capabilities: RunnerCapabilityReport['capabilities'] | null
}

interface ProjectInstanceStatusRow extends QueryResultRow {
  id: string
  project_id: string
  registered_at: Date
  last_seen_at: Date | null
}

interface JobRow extends QueryResultRow {
  id: string
  organization_id: string
  device_id: string
  project_instance_id: string
  protocol_version: ProtocolVersion
  idempotency_key: string
  job_kind: RunnerJob['kind']
  payload: RunnerJob['payload']
  issued_at: Date
  expires_at: Date
  lease_id: string | null
  lease_expires_at: Date | null
  cancel_requested_at: Date | null
  state: RunnerJobStatusResponse['state']
  result_json: ResultEnvelope | null
  result_digest: string | null
  request_digest: string | null
  acknowledged_at: Date | null
}

interface JobControlRow extends QueryResultRow {
  lease_id: string | null
  cancel_requested_at: Date | null
  state: RunnerJobStatusResponse['state']
}

function iso(value: Date | string): string {
  return typeof value === 'string' ? new Date(value).toISOString() : value.toISOString()
}

function enrollmentFromRow(row: EnrollmentRow): RunnerEnrollmentRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    createdBy: row.created_by,
    codeHash: row.code_hash,
    state: row.state,
    claimedDeviceId: row.claimed_device_id,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    claimedAt: row.claimed_at ? iso(row.claimed_at) : null,
  }
}

function authenticationFromRow(row: AuthenticationRow): RunnerAuthentication {
  return {
    organizationId: row.organization_id,
    deviceId: row.device_id,
    status: row.status,
  }
}

function envelopeFromRow(row: JobRow): JobEnvelope {
  return {
    protocolVersion: row.protocol_version,
    jobId: row.id,
    idempotencyKey: row.idempotency_key,
    organizationId: row.organization_id,
    deviceId: row.device_id,
    projectInstanceId: row.project_instance_id,
    issuedAt: iso(row.issued_at),
    expiresAt: iso(row.expires_at),
    job: {
      kind: row.job_kind,
      payload:
        typeof row.payload === 'string'
          ? (JSON.parse(row.payload) as RunnerJob['payload'])
          : row.payload,
    } as RunnerJob,
  }
}

function resultMatchesJob(job: JobEnvelope, result: ResultEnvelope): boolean {
  if (
    result.idempotencyKey !== job.idempotencyKey ||
    result.projectInstanceId !== job.projectInstanceId
  ) {
    return false
  }
  if (result.result.kind === 'error') return true
  if (result.result.payload.projectId !== job.job.payload.projectId) return false
  if (result.result.kind === 'cancellationReceipt') {
    return job.job.kind === 'applyPlan' || job.job.kind === 'rollbackOperation'
  }
  if (job.job.kind === 'scanProject') return result.result.kind === 'scanResult'
  if (job.job.kind === 'planSetup') {
    return (
      result.result.kind === 'planResult' &&
      result.result.payload.plan.setupRevisionId === job.job.payload.revision.setupRevisionId
    )
  }
  if (job.job.kind === 'applyPlan') {
    return (
      result.result.kind === 'applyReceipt' &&
      result.result.payload.setupRevisionId === job.job.payload.revision.setupRevisionId &&
      result.result.payload.planDigest === job.job.payload.approval.planDigest
    )
  }
  return (
    result.result.kind === 'rollbackReceipt' &&
    result.result.payload.operationId === job.job.payload.operationId
  )
}

async function persistPortableReceipt(
  client: PoolClient,
  job: JobEnvelope,
  result: ResultEnvelope,
  completedAt: string,
): Promise<void> {
  if (result.result.kind === 'applyReceipt') {
    const receipt = result.result.payload
    const approval = job.job.kind === 'applyPlan' ? job.job.payload.approval : null
    if (!approval) throw new Error('apply receipt is missing its approved job binding')
    await client.query(
      `INSERT INTO operation_receipts
       (operation_id, organization_id, device_id, project_instance_id, job_id,
        setup_revision_id, plan_digest, outcome, recoverability, receipt, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
      [
        receipt.operationId,
        job.organizationId,
        job.deviceId,
        job.projectInstanceId,
        job.jobId,
        receipt.setupRevisionId,
        receipt.planDigest,
        receipt.outcome,
        receipt.recoverability,
        JSON.stringify(result),
        completedAt,
      ],
    )
    await client.query(
      `INSERT INTO project_assignments
       (organization_id, project_id, setup_revision_id, assigned_by, assigned_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (organization_id, project_id) DO UPDATE
       SET setup_revision_id = EXCLUDED.setup_revision_id,
           assigned_by = EXCLUDED.assigned_by,
           assigned_at = EXCLUDED.assigned_at`,
      [
        job.organizationId,
        receipt.projectId,
        receipt.setupRevisionId,
        approval.approvedBy,
        completedAt,
      ],
    )
    await client.query(
      `INSERT INTO audit_events
       (id, organization_id, actor_user_id, event_kind, subject_id, details, created_at)
       VALUES ($1, $2, $3, 'setupApplied', $4, $5::jsonb, $6)`,
      [
        `audit_${job.jobId}`,
        job.organizationId,
        approval.approvedBy,
        receipt.operationId,
        JSON.stringify({
          projectInstanceId: job.projectInstanceId,
          setupRevisionId: receipt.setupRevisionId,
          planDigest: receipt.planDigest,
          outcome: receipt.outcome,
        }),
        completedAt,
      ],
    )
  } else if (result.result.kind === 'rollbackReceipt') {
    const receipt = result.result.payload
    const updated = await client.query(
      `UPDATE operation_receipts
       SET outcome = 'rolledBack', recoverability = $1, receipt = $2::jsonb,
           completed_at = $3
       WHERE organization_id = $4 AND project_instance_id = $5 AND operation_id = $6`,
      [
        receipt.recoverability,
        JSON.stringify(result),
        completedAt,
        job.organizationId,
        job.projectInstanceId,
        receipt.operationId,
      ],
    )
    if (updated.rowCount !== 1) throw new Error('rollback receipt has no matching apply receipt')
    if (receipt.restoredSetupRevisionId) {
      await client.query(
        `UPDATE project_assignments
         SET setup_revision_id = $1, assigned_at = $2
         WHERE organization_id = $3 AND project_id = (
           SELECT project_id FROM project_instances
           WHERE organization_id = $3 AND id = $4
         )`,
        [receipt.restoredSetupRevisionId, completedAt, job.organizationId, job.projectInstanceId],
      )
    } else {
      await client.query(
        `DELETE FROM project_assignments
         WHERE organization_id = $1 AND project_id = (
           SELECT project_id FROM project_instances
           WHERE organization_id = $1 AND id = $2
         )`,
        [job.organizationId, job.projectInstanceId],
      )
    }
    await client.query(
      `INSERT INTO audit_events
       (id, organization_id, actor_user_id, event_kind, subject_id, details, created_at)
       VALUES ($1, $2, NULL, 'setupRolledBack', $3, $4::jsonb, $5)`,
      [
        `audit_${job.jobId}`,
        job.organizationId,
        receipt.operationId,
        JSON.stringify({
          projectInstanceId: job.projectInstanceId,
          restoredSetupRevisionId: receipt.restoredSetupRevisionId,
        }),
        completedAt,
      ],
    )
  }
}

async function transaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await operation(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export class PostgresRunnerTransportRepository implements RunnerTransportRepository {
  constructor(private readonly pool: Pool, private readonly browserClient?: PoolClient) {}

  private get browserDatabase(): Pool | PoolClient {
    return this.browserClient ?? this.pool
  }

  async withActor<T>(actor: RequestActor, access: BrowserAccess, operation: (repository: BrowserRunnerRepository) => Promise<T>): Promise<T> {
    return transaction(this.pool, async (client) => {
      const membership = await client.query<{ role: MembershipRole }>(
        `SELECT role FROM organization_memberships WHERE organization_id = $1 AND user_id = $2 FOR SHARE`,
        [actor.organizationId, actor.userId],
      )
      if (!membershipAllows(membership.rows[0]?.role, access)) {
        throw new RunnerTransportError(403, 'organization membership does not permit this operation')
      }
      return operation(new PostgresRunnerTransportRepository(this.pool, client))
    })
  }

  async createEnrollment(record: RunnerEnrollmentRecord): Promise<void> {
    await this.browserDatabase.query(
      `INSERT INTO runner_enrollments
       (id, organization_id, created_by, code_hash, state, claimed_device_id,
        created_at, expires_at, claimed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        record.id,
        record.organizationId,
        record.createdBy,
        record.codeHash,
        record.state,
        record.claimedDeviceId,
        record.createdAt,
        record.expiresAt,
        record.claimedAt,
      ],
    )
  }

  async enrollmentStatus(
    organizationId: string,
    enrollmentId: string,
    now: string,
  ): Promise<RunnerEnrollmentRecord | null> {
    await this.browserDatabase.query(
      `UPDATE runner_enrollments SET state = 'expired'
       WHERE id = $1 AND organization_id = $2 AND state = 'waiting' AND expires_at <= $3`,
      [enrollmentId, organizationId, now],
    )
    const result = await this.browserDatabase.query<EnrollmentRow>(
      `SELECT * FROM runner_enrollments WHERE id = $1 AND organization_id = $2`,
      [enrollmentId, organizationId],
    )
    return result.rows[0] ? enrollmentFromRow(result.rows[0]) : null
  }

  async claimEnrollment(
    codeHash: string,
    device: RunnerDeviceRegistration,
    now: string,
  ): Promise<RunnerAuthentication | null> {
    return transaction(this.pool, async (client) => {
      const found = await client.query<EnrollmentRow>(
        `SELECT * FROM runner_enrollments
         WHERE code_hash = $1 AND state = 'waiting'
         FOR UPDATE`,
        [codeHash],
      )
      const enrollment = found.rows[0]
      if (!enrollment) return null
      if (iso(enrollment.expires_at) <= now) {
        await client.query(`UPDATE runner_enrollments SET state = 'expired' WHERE id = $1`, [
          enrollment.id,
        ])
        return null
      }
      await client.query(
        `INSERT INTO runner_devices
         (id, organization_id, label, credential_hash, status, enrolled_at,
          runner_version, supported_protocol_versions, capabilities)
         VALUES ($1, $2, $3, $4, 'active', $5, $6, $7::jsonb, $8::jsonb)`,
        [
          device.id,
          enrollment.organization_id,
          device.label,
          device.credentialHash,
          device.enrolledAt,
          device.capabilities.runnerVersion,
          JSON.stringify(device.capabilities.supportedProtocolVersions),
          JSON.stringify(device.capabilities.capabilities),
        ],
      )
      await client.query(
        `UPDATE runner_enrollments
         SET state = 'claimed', claimed_device_id = $1, claimed_at = $2
         WHERE id = $3`,
        [device.id, now, enrollment.id],
      )
      return {
        organizationId: enrollment.organization_id,
        deviceId: device.id,
        status: 'active',
      }
    })
  }

  async authenticateRunner(credentialHash: string): Promise<RunnerAuthentication | null> {
    const result = await this.pool.query<AuthenticationRow>(
      `SELECT organization_id, id AS device_id, status
       FROM runner_devices WHERE credential_hash = $1`,
      [credentialHash],
    )
    return result.rows[0] ? authenticationFromRow(result.rows[0]) : null
  }

  async runnerStatus(
    organizationId: string,
    deviceId: string,
  ): Promise<RunnerStatusResponse | null> {
    const [deviceResult, projectInstancesResult] = await Promise.all([
      this.browserDatabase.query<RunnerStatusRow>(
        `SELECT id, label, status, enrolled_at, last_seen_at, runner_version,
                supported_protocol_versions, capabilities
         FROM runner_devices WHERE organization_id = $1 AND id = $2`,
        [organizationId, deviceId],
      ),
      this.browserDatabase.query<ProjectInstanceStatusRow>(
        `SELECT id, project_id, registered_at, last_seen_at
         FROM project_instances
         WHERE organization_id = $1 AND device_id = $2
         ORDER BY registered_at, id`,
        [organizationId, deviceId],
      ),
    ])
    const device = deviceResult.rows[0]
    if (!device) return null
    const capabilities =
      device.runner_version && device.supported_protocol_versions && device.capabilities
        ? {
            protocolVersion: PROTOCOL_VERSION,
            supportedProtocolVersions: device.supported_protocol_versions,
            runnerVersion: device.runner_version,
            capabilities: device.capabilities,
          }
        : null
    return {
      deviceId: device.id,
      label: device.label,
      status: device.status,
      enrolledAt: iso(device.enrolled_at),
      lastSeenAt: device.last_seen_at ? iso(device.last_seen_at) : null,
      capabilities,
      projectInstances: projectInstancesResult.rows.map((instance) => ({
        projectInstanceId: instance.id,
        projectId: instance.project_id,
        registeredAt: iso(instance.registered_at),
        lastSeenAt: instance.last_seen_at ? iso(instance.last_seen_at) : null,
      })),
    }
  }

  async registerProjectInstance(
    runner: RunnerAuthentication,
    request: RegisterProjectInstanceRequest,
    now: string,
  ): Promise<boolean> {
    const project = await this.pool.query(
      `SELECT 1 FROM projects WHERE organization_id = $1 AND id = $2`,
      [runner.organizationId, request.projectId],
    )
    if (project.rowCount === 0) return false
    const result = await this.pool.query(
      `INSERT INTO project_instances
       (id, organization_id, project_id, device_id, registered_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (id) DO UPDATE
       SET project_id = EXCLUDED.project_id, last_seen_at = EXCLUDED.last_seen_at
       WHERE project_instances.organization_id = EXCLUDED.organization_id
         AND project_instances.device_id = EXCLUDED.device_id`,
      [
        request.projectInstanceId,
        runner.organizationId,
        request.projectId,
        runner.deviceId,
        now,
      ],
    )
    return result.rowCount === 1
  }

  async projectInstance(
    organizationId: string,
    projectInstanceId: string,
  ): Promise<ProjectInstanceRoute | null> {
    const result = await this.browserDatabase.query<
      QueryResultRow & { organization_id: string; id: string; project_id: string; device_id: string }
    >(
      `SELECT organization_id, id, project_id, device_id
       FROM project_instances WHERE organization_id = $1 AND id = $2`,
      [organizationId, projectInstanceId],
    )
    const row = result.rows[0]
    return row
      ? {
          organizationId: row.organization_id,
          projectInstanceId: row.id,
          projectId: row.project_id,
          deviceId: row.device_id,
        }
      : null
  }

  async enqueueJob(job: JobEnvelope): Promise<void> {
    await this.browserDatabase.query(
      `INSERT INTO runner_jobs
       (id, organization_id, device_id, project_instance_id, protocol_version,
        idempotency_key, job_kind, payload, state, issued_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'pending', $9, $10)`,
      [
        job.jobId,
        job.organizationId,
        job.deviceId,
        job.projectInstanceId,
        job.protocolVersion,
        job.idempotencyKey,
        job.job.kind,
        JSON.stringify(job.job.payload),
        job.issuedAt,
        job.expiresAt,
      ],
    )
  }

  async storeArtifact(
    runner: RunnerAuthentication,
    bundle: ArtifactBundle,
    now: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO artifact_bundles
       (organization_id, content_digest, bundle, uploaded_by_device_id, created_at)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       ON CONFLICT (organization_id, content_digest) DO NOTHING`,
      [
        runner.organizationId,
        bundle.contentDigest,
        JSON.stringify(bundle),
        runner.deviceId,
        now,
      ],
    )
  }

  async loadArtifact(
    runner: RunnerAuthentication,
    contentDigest: string,
  ): Promise<ArtifactBundle | null> {
    const result = await this.pool.query<QueryResultRow & { bundle: ArtifactBundle | string }>(
      `SELECT bundle FROM artifact_bundles
       WHERE organization_id = $1 AND content_digest = $2`,
      [runner.organizationId, contentDigest],
    )
    const bundle = result.rows[0]?.bundle
    return bundle
      ? typeof bundle === 'string'
        ? (JSON.parse(bundle) as ArtifactBundle)
        : bundle
      : null
  }

  async claimJob(
    runner: RunnerAuthentication,
    supportedKinds: readonly string[],
    capabilities: RunnerCapabilityReport,
    leaseId: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<LeasedRunnerJob | null> {
    return transaction(this.pool, async (client) => {
      await client.query(
        `UPDATE runner_devices
         SET last_seen_at = $1, runner_version = $2,
             supported_protocol_versions = $3::jsonb, capabilities = $4::jsonb
         WHERE organization_id = $5 AND id = $6 AND status = 'active'`,
        [
          now,
          capabilities.runnerVersion,
          JSON.stringify(capabilities.supportedProtocolVersions),
          JSON.stringify(capabilities.capabilities),
          runner.organizationId,
          runner.deviceId,
        ],
      )
      await client.query(
        `UPDATE runner_jobs SET state = 'expired'
         WHERE device_id = $1 AND state IN ('pending', 'leased')
           AND expires_at <= $2`,
        [runner.deviceId, now],
      )
      const existing = await client.query<JobRow>(
        `SELECT * FROM runner_jobs
         WHERE organization_id = $1 AND device_id = $2
           AND state IN ('leased', 'acknowledged')
           AND lease_expires_at > $3 AND job_kind = ANY($4::text[])
         ORDER BY issued_at LIMIT 1`,
        [runner.organizationId, runner.deviceId, now, supportedKinds],
      )
      if (existing.rows[0]) return this.leasedFromRow(existing.rows[0])

      const selected = await client.query<JobRow>(
        `SELECT * FROM runner_jobs
         WHERE organization_id = $1 AND device_id = $2
           AND ((state IN ('pending', 'leased') AND expires_at > $3
                 AND (state = 'pending' OR lease_expires_at <= $3))
                OR (state = 'acknowledged' AND lease_expires_at <= $3))
           AND job_kind = ANY($4::text[])
         ORDER BY issued_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [runner.organizationId, runner.deviceId, now, supportedKinds],
      )
      const job = selected.rows[0]
      if (!job) return null
      const updated = await client.query<JobRow>(
        `UPDATE runner_jobs
         SET state = 'leased', lease_id = $1, lease_expires_at = $2,
             request_digest = NULL, acknowledged_at = NULL,
             attempt_count = attempt_count + 1
         WHERE id = $3 RETURNING *`,
        [leaseId, leaseExpiresAt, job.id],
      )
      return this.leasedFromRow(updated.rows[0] as JobRow)
    })
  }

  async acknowledgeJob(
    runner: RunnerAuthentication,
    jobId: string,
    leaseId: string,
    requestDigest: string,
    now: string,
  ): Promise<JobAcknowledgement> {
    return transaction(this.pool, async (client) => {
      const found = await client.query<JobRow>(
        `SELECT * FROM runner_jobs
         WHERE organization_id = $1 AND device_id = $2 AND id = $3
         FOR UPDATE`,
        [runner.organizationId, runner.deviceId, jobId],
      )
      const job = found.rows[0]
      if (!job) return { outcome: 'unknown' }
      if (job.state === 'acknowledged') {
        return {
          outcome:
            job.lease_id === leaseId && job.request_digest === requestDigest
              ? 'duplicate'
              : 'conflict',
        }
      }
      if (job.state !== 'leased' || job.lease_id !== leaseId) {
        return { outcome: 'conflict' }
      }
      await client.query(
        `UPDATE runner_jobs
         SET state = 'acknowledged', request_digest = $1, acknowledged_at = $2
         WHERE id = $3`,
        [requestDigest, now, jobId],
      )
      return { outcome: 'accepted' }
    })
  }

  async completeJob(
    runner: RunnerAuthentication,
    jobId: string,
    leaseId: string,
    result: ResultEnvelope,
    resultDigest: string,
    now: string,
  ): Promise<JobCompletion> {
    return transaction(this.pool, async (client) => {
      const found = await client.query<JobRow>(
        `SELECT * FROM runner_jobs
         WHERE organization_id = $1 AND device_id = $2 AND id = $3
         FOR UPDATE`,
        [runner.organizationId, runner.deviceId, jobId],
      )
      const job = found.rows[0]
      if (!job) return { outcome: 'unknown' }
      if (job.result_digest) {
        return { outcome: job.result_digest === resultDigest ? 'duplicate' : 'conflict' }
      }
      if (job.state !== 'acknowledged' || job.lease_id !== leaseId) {
        return { outcome: 'conflict' }
      }
      const envelope = envelopeFromRow(job)
      if (!resultMatchesJob(envelope, result)) return { outcome: 'conflict' }
      const terminalState =
        result.result.kind === 'cancellationReceipt' ||
        (result.result.kind === 'error' && result.result.payload.code === 'jobCancelled')
          ? 'cancelled'
          : result.result.kind === 'error'
            ? 'failed'
            : 'succeeded'
      await client.query(
        `UPDATE runner_jobs
         SET state = $1, result_json = $2::jsonb, result_digest = $3, completed_at = $4
         WHERE id = $5`,
        [terminalState, JSON.stringify(result), resultDigest, now, jobId],
      )
      if (terminalState === 'succeeded') {
        await persistPortableReceipt(client, envelope, result, now)
      }
      return { outcome: 'accepted' }
    })
  }

  async jobControl(
    runner: RunnerAuthentication,
    jobId: string,
    leaseId: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<JobControlCheck> {
    await this.pool.query(
      `UPDATE runner_devices SET last_seen_at = $1
       WHERE organization_id = $2 AND id = $3 AND status = 'active'`,
      [now, runner.organizationId, runner.deviceId],
    )
    const result = await this.pool.query<JobControlRow>(
      `UPDATE runner_jobs SET lease_expires_at = $1
       WHERE organization_id = $2 AND device_id = $3 AND id = $4 AND lease_id = $5
         AND state IN ('leased', 'acknowledged')
       RETURNING lease_id, cancel_requested_at, state`,
      [leaseExpiresAt, runner.organizationId, runner.deviceId, jobId, leaseId],
    )
    const job = result.rows[0]
    if (!job) {
      const exists = await this.pool.query(
        `SELECT 1 FROM runner_jobs
         WHERE organization_id = $1 AND device_id = $2 AND id = $3`,
        [runner.organizationId, runner.deviceId, jobId],
      )
      return { outcome: exists.rows[0] ? 'conflict' : 'unknown' }
    }
    return {
      outcome: 'available',
      cancelRequested: job.cancel_requested_at !== null,
    }
  }

  async jobStatus(
    organizationId: string,
    jobId: string,
  ): Promise<RunnerJobStatusResponse | null> {
    const result = await this.browserDatabase.query<JobRow>(
      `SELECT * FROM runner_jobs WHERE organization_id = $1 AND id = $2`,
      [organizationId, jobId],
    )
    const row = result.rows[0]
    return row
      ? {
          jobId: row.id,
          state: row.state,
          result: row.result_json,
          cancelRequested: row.cancel_requested_at !== null,
        }
      : null
  }

  async requestCancellation(
    organizationId: string,
    jobId: string,
    now: string,
  ): Promise<boolean> {
    const result = await this.browserDatabase.query(
      `UPDATE runner_jobs
       SET cancel_requested_at = $1,
           state = CASE WHEN state = 'pending' THEN 'cancelled' ELSE state END,
           completed_at = CASE WHEN state = 'pending' THEN $1 ELSE completed_at END
       WHERE organization_id = $2 AND id = $3
         AND state IN ('pending', 'leased', 'acknowledged')`,
      [now, organizationId, jobId],
    )
    return result.rowCount === 1
  }

  async revokeRunner(organizationId: string, deviceId: string): Promise<boolean> {
    const result = await this.browserDatabase.query(
      `UPDATE runner_devices SET status = 'revoked'
       WHERE organization_id = $1 AND id = $2 AND status = 'active'`,
      [organizationId, deviceId],
    )
    return result.rowCount === 1
  }

  private leasedFromRow(row: JobRow): LeasedRunnerJob {
    return {
      leaseId: row.lease_id as string,
      leaseExpiresAt: iso(row.lease_expires_at as Date),
      cancelRequested: row.cancel_requested_at !== null,
      job: envelopeFromRow(row),
    }
  }
}
