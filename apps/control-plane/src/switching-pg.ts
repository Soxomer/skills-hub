import {
  PROTOCOL_VERSION,
  type JobEnvelope,
  type PortableSetupRevision,
  type ProjectActiveOperation,
  type ProjectInstanceOperationsResponse,
  type ProjectOperationSummary,
  type ProjectSetupStateResponse,
  type ResultEnvelope,
  type RunnerCapabilities,
} from '@ahm/contracts'
import type { Pool, PoolClient, QueryResultRow } from 'pg'

import type {
  ApplyQueueOutcome,
  PlanQueueOutcome,
  RollbackQueueOutcome,
  SetupRevisionContext,
  SwitchingRepository,
} from './switching.js'

interface RevisionRow extends QueryResultRow {
  setup_id: string
  setup_revision_id: string
  name: string
  kind: 'default' | 'custom'
  revision_number: number | string
  item_count: number | string
  created_at: Date | string
}

interface RevisionItemRow extends QueryResultRow {
  artifact_id: string
  artifact_kind: 'skill' | 'pluginSkill' | 'localContent'
  artifact_reference: { portableSource?: unknown; contentDigest?: unknown } | string
  tool_id: string
  target_name: string
}

interface RouteRow extends QueryResultRow {
  organization_id: string
  project_id: string
  project_instance_id: string
  device_id: string
  device_status: 'active' | 'revoked'
  runner_last_seen_at: Date | string | null
  capabilities: RunnerCapabilities | string | null
}

interface PlanRow extends RouteRow {
  state: string
  payload: JobEnvelope['job']['payload'] | string
  result_json: ResultEnvelope | string | null
}

interface ExistingApplyRow extends QueryResultRow {
  approval_id: string
  job_id: string | null
  device_id: string
}

interface ReceiptRow extends RouteRow {
  outcome: string
  recoverability: string
}

interface OperationRow extends QueryResultRow {
  id: string
  job_kind: 'applyPlan' | 'rollbackOperation'
  state: ProjectOperationSummary['state']
  payload: JobEnvelope['job']['payload'] | string
  result_json: ResultEnvelope | string | null
  issued_at: Date | string
  completed_at: Date | string | null
}

interface ActiveOperationRow extends QueryResultRow {
  id: string
  job_kind: ProjectActiveOperation['kind']
  state: ProjectActiveOperation['state']
  payload: JobEnvelope['job']['payload'] | string
  cancel_requested_at: Date | string | null
  issued_at: Date | string
}

interface PlanAttemptRow extends QueryResultRow {
  id: string
  state: ProjectOperationSummary['state']
  result_json: ResultEnvelope | string | null
  issued_at: Date | string
  completed_at: Date | string | null
}

function iso(value: Date | string): string {
  return typeof value === 'string' ? new Date(value).toISOString() : value.toISOString()
}

function objectValue<T>(value: T | string): T {
  return typeof value === 'string' ? (JSON.parse(value) as T) : value
}

function routeFromRow(row: RouteRow): SetupRevisionContext['route'] {
  return {
    organizationId: row.organization_id,
    projectId: row.project_id,
    projectInstanceId: row.project_instance_id,
    deviceId: row.device_id,
    deviceStatus: row.device_status,
    runnerLastSeenAt: row.runner_last_seen_at ? iso(row.runner_last_seen_at) : null,
    capabilities: row.capabilities ? objectValue(row.capabilities) : null,
  }
}

function artifactReference(row: RevisionItemRow): Record<string, unknown> {
  return objectValue(row.artifact_reference)
}

function activeOperationFromRow(row: ActiveOperationRow): ProjectActiveOperation {
  const payload = objectValue(row.payload)
  return {
    jobId: row.id,
    kind: row.job_kind,
    state: row.state,
    setupRevisionId:
      'revision' in payload ? payload.revision.setupRevisionId : null,
    cancelRequested: row.cancel_requested_at !== null,
    issuedAt: iso(row.issued_at),
  }
}

async function expirePendingSetupOperations(
  client: Pick<Pool, 'query'>,
  organizationId: string,
  projectInstanceId: string,
  now: string,
): Promise<void> {
  await client.query(
    `UPDATE runner_jobs
     SET state = 'expired', completed_at = $1
     WHERE organization_id = $2 AND project_instance_id = $3
       AND job_kind IN ('planSetup', 'applyPlan', 'rollbackOperation')
       AND state = 'pending'
       AND expires_at <= $1`,
    [now, organizationId, projectInstanceId],
  )
}

async function activeSetupOperation(
  client: Pick<Pool, 'query'>,
  organizationId: string,
  projectInstanceId: string,
): Promise<ProjectActiveOperation | null> {
  const active = await client.query<ActiveOperationRow>(
    `SELECT id, job_kind, state, payload, cancel_requested_at, issued_at
     FROM runner_jobs
     WHERE organization_id = $1 AND project_instance_id = $2
       AND job_kind IN ('planSetup', 'applyPlan', 'rollbackOperation')
       AND state IN ('pending', 'leased', 'acknowledged')
     ORDER BY issued_at, id
     LIMIT 1`,
    [organizationId, projectInstanceId],
  )
  return active.rows[0] ? activeOperationFromRow(active.rows[0]) : null
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

async function insertJob(client: Pick<Pool, 'query'>, job: JobEnvelope): Promise<void> {
  const setupRevisionId =
    job.job.kind === 'planSetup' || job.job.kind === 'applyPlan'
      ? job.job.payload.revision.setupRevisionId
      : null
  await client.query(
    `INSERT INTO runner_jobs
     (id, organization_id, device_id, project_instance_id, protocol_version,
      idempotency_key, job_kind, payload, setup_revision_id, state, issued_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, 'pending', $10, $11)`,
    [
      job.jobId,
      job.organizationId,
      job.deviceId,
      job.projectInstanceId,
      job.protocolVersion,
      job.idempotencyKey,
      job.job.kind,
      JSON.stringify(job.job.payload),
      setupRevisionId,
      job.issuedAt,
      job.expiresAt,
    ],
  )
}

function runnerAvailability(
  row: RouteRow,
  capability: keyof Pick<RunnerCapabilities, 'planSetup' | 'applyPlan' | 'rollbackOperation'>,
  freshAfter: string,
): 'available' | 'offline' | 'capabilityUnavailable' {
  if (
    row.device_status !== 'active' ||
    !row.runner_last_seen_at ||
    iso(row.runner_last_seen_at) < freshAfter
  ) {
    return 'offline'
  }
  const capabilities = row.capabilities ? objectValue(row.capabilities) : null
  return capabilities?.[capability] ? 'available' : 'capabilityUnavailable'
}

export class PostgresSwitchingRepository implements SwitchingRepository {
  constructor(private readonly pool: Pool) {}

  async projectSetupState(
    organizationId: string,
    projectId: string,
  ): Promise<ProjectSetupStateResponse | null> {
    const project = await this.pool.query<QueryResultRow & { id: string }>(
      `SELECT id FROM projects WHERE organization_id = $1 AND id = $2`,
      [organizationId, projectId],
    )
    if (!project.rows[0]) return null
    const [revisions, defaults, assignment] = await Promise.all([
      this.pool.query<RevisionRow>(
        `SELECT s.id AS setup_id, sr.id AS setup_revision_id, s.name, s.kind,
                sr.revision_number, sr.created_at, COUNT(sri.artifact_id) AS item_count
         FROM setups s
         JOIN setup_revisions sr
           ON sr.organization_id = s.organization_id AND sr.setup_id = s.id
         LEFT JOIN setup_revision_items sri
           ON sri.organization_id = sr.organization_id AND sri.setup_revision_id = sr.id
         WHERE s.organization_id = $1
         GROUP BY s.id, sr.id, s.name, s.kind, sr.revision_number, sr.created_at
         ORDER BY LOWER(s.name), sr.revision_number DESC`,
        [organizationId],
      ),
      this.pool.query<QueryResultRow & { id: string }>(
        `SELECT sr.id
         FROM setups s
         JOIN setup_revisions sr
           ON sr.organization_id = s.organization_id AND sr.setup_id = s.id
         WHERE s.organization_id = $1 AND s.default_project_id = $2
         ORDER BY sr.revision_number DESC LIMIT 1`,
        [organizationId, projectId],
      ),
      this.pool.query<QueryResultRow & { setup_revision_id: string }>(
        `SELECT setup_revision_id FROM project_assignments
         WHERE organization_id = $1 AND project_id = $2`,
        [organizationId, projectId],
      ),
    ])
    return {
      projectId,
      defaultSetupRevisionId: defaults.rows[0]?.id ?? null,
      assignedSetupRevisionId: assignment.rows[0]?.setup_revision_id ?? null,
      revisions: revisions.rows.map((row) => ({
        setupId: row.setup_id,
        setupRevisionId: row.setup_revision_id,
        name: row.name,
        kind: row.kind,
        revisionNumber: Number(row.revision_number),
        itemCount: Number(row.item_count),
        createdAt: iso(row.created_at),
      })),
    }
  }

  async projectInstanceOperations(
    organizationId: string,
    projectInstanceId: string,
  ): Promise<ProjectInstanceOperationsResponse | null> {
    const instance = await this.pool.query<QueryResultRow & { assigned_setup_revision_id: string | null }>(
      `SELECT pa.setup_revision_id AS assigned_setup_revision_id
       FROM project_instances pi
       LEFT JOIN project_assignments pa
         ON pa.organization_id = pi.organization_id AND pa.project_id = pi.project_id
       WHERE pi.organization_id = $1 AND pi.id = $2`,
      [organizationId, projectInstanceId],
    )
    if (!instance.rows[0]) return null

    const assignedSetupRevisionId = instance.rows[0].assigned_setup_revision_id
    const [operationRows, latestPlanAttemptRows, latestAssignedPlanRows, activeOperationRows] =
      await Promise.all([
      this.pool.query<OperationRow>(
        `SELECT id, job_kind, state, payload, result_json, issued_at, completed_at
         FROM runner_jobs
         WHERE organization_id = $1 AND project_instance_id = $2
           AND job_kind IN ('applyPlan', 'rollbackOperation')
         ORDER BY issued_at DESC, completed_at DESC, id DESC
         LIMIT 10`,
        [organizationId, projectInstanceId],
      ),
      this.pool.query<PlanAttemptRow>(
        `SELECT id, state, result_json, issued_at, completed_at
         FROM runner_jobs
         WHERE organization_id = $1 AND project_instance_id = $2
           AND job_kind = 'planSetup'
         ORDER BY issued_at DESC, id DESC
         LIMIT 1`,
        [organizationId, projectInstanceId],
      ),
      this.pool.query<PlanAttemptRow>(
        `SELECT id, state, result_json, issued_at, completed_at
         FROM runner_jobs
         WHERE organization_id = $1 AND project_instance_id = $2
           AND job_kind = 'planSetup' AND state = 'succeeded' AND result_json IS NOT NULL
           AND setup_revision_id = $3
         ORDER BY completed_at DESC, id DESC
         LIMIT 1`,
        [organizationId, projectInstanceId, assignedSetupRevisionId],
      ),
      this.pool.query<ActiveOperationRow>(
        `SELECT id, job_kind, state, payload, cancel_requested_at, issued_at
         FROM runner_jobs
         WHERE organization_id = $1 AND project_instance_id = $2
           AND job_kind IN ('planSetup', 'applyPlan', 'rollbackOperation')
           AND state IN ('pending', 'leased', 'acknowledged')
         ORDER BY issued_at, id
         LIMIT 1`,
        [organizationId, projectInstanceId],
      ),
      ])

    const operations = operationRows.rows.map((row): ProjectOperationSummary => {
      const payload = objectValue(row.payload)
      const result = row.result_json ? objectValue(row.result_json).result : null
      const receipt =
        result?.kind === 'applyReceipt' ||
        result?.kind === 'rollbackReceipt' ||
        result?.kind === 'cancellationReceipt'
          ? result.payload
          : null
      const error = result?.kind === 'error' ? result.payload : null
      const setupRevisionId = row.job_kind === 'applyPlan' && 'revision' in payload
        ? payload.revision.setupRevisionId
        : receipt && 'restoredSetupRevisionId' in receipt
          ? receipt.restoredSetupRevisionId
          : receipt && 'setupRevisionId' in receipt
            ? receipt.setupRevisionId
            : null
      const operationId = receipt?.operationId ??
        (row.job_kind === 'rollbackOperation' && 'operationId' in payload
          ? payload.operationId
          : null)
      return {
        jobId: row.id,
        kind: row.job_kind,
        state: row.state,
        setupRevisionId,
        operationId,
        outcome: receipt?.outcome ?? null,
        recoverability: receipt?.recoverability ?? error?.recoverability ?? null,
        errorCode: error?.code ?? null,
        retryable: error?.retryable ?? null,
        issuedAt: iso(row.issued_at),
        completedAt: row.completed_at ? iso(row.completed_at) : null,
      }
    })

    const latestCompleted = operations.find((operation) => operation.state === 'succeeded')
    const latestOperation = operations[0] ?? null
    const latestPlanAttempt = latestPlanAttemptRows.rows[0] ?? null
    const latestPlanResult = latestPlanAttempt?.result_json
      ? objectValue(latestPlanAttempt.result_json).result
      : null
    const latestAssignedPlan = latestAssignedPlanRows.rows[0] ?? null
    const latestAssignedPlanResult = latestAssignedPlan?.result_json
      ? objectValue(latestAssignedPlan.result_json).result
      : null
    const latestPlanCompletedAt = latestAssignedPlan?.completed_at ?? null
    const planForAssignment =
      latestAssignedPlanResult?.kind === 'planResult'
        ? latestAssignedPlanResult.payload.plan
        : null
    const latestOperationBarrier = latestOperation?.completedAt ?? latestOperation?.issuedAt ?? null
    const planIsNewerThanLatestOperation = Boolean(
      latestPlanCompletedAt &&
        (!latestOperationBarrier ||
          new Date(latestPlanCompletedAt).getTime() > new Date(latestOperationBarrier).getTime()),
    )
    const planHasChanges = Boolean(
      planForAssignment?.conflicts.length ||
        planForAssignment?.actions.some(
          (action) => action.change !== 'unchanged' || action.metadataOnly,
        ),
    )
    const requiresAttention =
      latestOperation?.recoverability === 'manualIntervention' &&
      (latestOperation.state === 'failed' || latestOperation.state === 'cancelled') &&
      !(planForAssignment && planIsNewerThanLatestOperation)
    const materializedSetupRevisionId =
      planForAssignment && planIsNewerThanLatestOperation && !planHasChanges
        ? assignedSetupRevisionId
        : (latestCompleted?.setupRevisionId ?? null)
    const hasDrift = Boolean(planForAssignment && planIsNewerThanLatestOperation && planHasChanges)
    const latestPlanIsReviewable = Boolean(
      latestPlanAttempt?.state === 'succeeded' &&
        latestPlanResult?.kind === 'planResult' &&
        latestPlanAttempt.completed_at &&
        (!latestOperationBarrier ||
          new Date(latestPlanAttempt.completed_at).getTime() >
            new Date(latestOperationBarrier).getTime()),
    )
    const health = requiresAttention
      ? 'attention'
      : hasDrift ||
          (materializedSetupRevisionId !== null &&
            materializedSetupRevisionId !== assignedSetupRevisionId)
        ? 'drifted'
        : materializedSetupRevisionId !== null || assignedSetupRevisionId === null
          ? 'current'
          : 'unknown'

    return {
      projectInstanceId,
      assignedSetupRevisionId,
      materializedSetupRevisionId,
      health,
      activeOperation: activeOperationRows.rows[0]
        ? activeOperationFromRow(activeOperationRows.rows[0])
        : null,
      reviewedPlan:
        latestPlanIsReviewable && latestPlanAttempt && latestPlanResult?.kind === 'planResult'
          ? { jobId: latestPlanAttempt.id, plan: latestPlanResult.payload.plan }
          : null,
      operations,
    }
  }

  async revisionContext(
    organizationId: string,
    projectInstanceId: string,
    setupRevisionId: string,
  ): Promise<SetupRevisionContext | null> {
    const context = await this.pool.query<RouteRow & { setup_id: string; revision_number: number }>(
      `SELECT pi.organization_id, pi.project_id, pi.id AS project_instance_id,
              rd.id AS device_id, rd.status AS device_status,
              rd.last_seen_at AS runner_last_seen_at, rd.capabilities,
              sr.setup_id, sr.revision_number
       FROM project_instances pi
       JOIN runner_devices rd
         ON rd.organization_id = pi.organization_id AND rd.id = pi.device_id
       JOIN setup_revisions sr ON sr.organization_id = pi.organization_id
       WHERE pi.organization_id = $1 AND pi.id = $2 AND sr.id = $3`,
      [organizationId, projectInstanceId, setupRevisionId],
    )
    const row = context.rows[0]
    if (!row) return null
    const items = await this.pool.query<RevisionItemRow>(
      `SELECT artifact_id, artifact_kind, artifact_reference, tool_id, target_name
       FROM setup_revision_items
       WHERE organization_id = $1 AND setup_revision_id = $2
       ORDER BY tool_id, target_name, artifact_id`,
      [organizationId, setupRevisionId],
    )
    const revision: PortableSetupRevision = {
      setupId: row.setup_id,
      setupRevisionId,
      revisionNumber: Number(row.revision_number),
      items: items.rows.map((item) => {
        const reference = artifactReference(item)
        return {
          artifactId: item.artifact_id,
          artifactKind: item.artifact_kind,
          portableSource:
            typeof reference.portableSource === 'string' ? reference.portableSource : null,
          contentDigest:
            typeof reference.contentDigest === 'string' ? reference.contentDigest : '',
          toolId: item.tool_id,
          targetName: item.target_name,
        }
      }),
    }
    return { route: routeFromRow(row), revision }
  }

  async enqueuePlan(job: JobEnvelope): Promise<PlanQueueOutcome> {
    return transaction(this.pool, async (client) => {
      await client.query(
        `SELECT id FROM project_instances
         WHERE organization_id = $1 AND id = $2
         FOR UPDATE`,
        [job.organizationId, job.projectInstanceId],
      )
      await expirePendingSetupOperations(
        client,
        job.organizationId,
        job.projectInstanceId,
        job.issuedAt,
      )
      const activeOperation = await activeSetupOperation(
        client,
        job.organizationId,
        job.projectInstanceId,
      )
      if (activeOperation) return { outcome: 'operationInProgress', activeOperation }
      await insertJob(client, job)
      return { outcome: 'queued', jobId: job.jobId, deviceId: job.deviceId }
    })
  }

  async approveAndEnqueueApply(input: {
    actor: { organizationId: string; userId: string }
    projectInstanceId: string
    planJobId: string
    planDigest: string
    approvalId: string
    applyJobId: string
    issuedAt: string
    expiresAt: string
    runnerFreshAfter: string
  }): Promise<ApplyQueueOutcome> {
    return transaction(this.pool, async (client) => {
      const found = await client.query<PlanRow>(
        `SELECT pi.organization_id, pi.project_id, pi.id AS project_instance_id,
                rd.id AS device_id, rd.status AS device_status,
                rd.last_seen_at AS runner_last_seen_at, rd.capabilities,
                j.state, j.payload, j.result_json
         FROM project_instances pi
         JOIN runner_devices rd
           ON rd.organization_id = pi.organization_id AND rd.id = pi.device_id
         JOIN runner_jobs j
           ON j.organization_id = pi.organization_id AND j.project_instance_id = pi.id
             AND j.id = $3 AND j.job_kind = 'planSetup'
         WHERE pi.organization_id = $1 AND pi.id = $2
         FOR UPDATE`,
        [input.actor.organizationId, input.projectInstanceId, input.planJobId],
      )
      const row = found.rows[0]
      if (!row || !row.state) return { outcome: 'planMissing' }
      const latestPlanAttempt = await client.query<QueryResultRow & { id: string }>(
        `SELECT id FROM runner_jobs
         WHERE organization_id = $1 AND project_instance_id = $2 AND job_kind = 'planSetup'
         ORDER BY issued_at DESC, id DESC
         LIMIT 1`,
        [input.actor.organizationId, input.projectInstanceId],
      )
      if (latestPlanAttempt.rows[0]?.id !== input.planJobId) return { outcome: 'planMismatch' }
      if (row.state !== 'succeeded' || !row.result_json) return { outcome: 'planNotReady' }
      const result = objectValue(row.result_json)
      const payload = objectValue(row.payload)
      if (
        result.result.kind !== 'planResult' ||
        result.result.payload.projectId !== row.project_id ||
        payload === null ||
        typeof payload !== 'object' ||
        !('revision' in payload)
      ) {
        return { outcome: 'planMismatch' }
      }
      const revision = (payload as { revision: PortableSetupRevision }).revision
      const plan = result.result.payload.plan
      if (
        plan.planDigest !== input.planDigest ||
        plan.setupRevisionId !== revision.setupRevisionId
      ) {
        return { outcome: 'planMismatch' }
      }
      if (plan.conflicts.length > 0) return { outcome: 'planHasConflicts' }
      const availability = runnerAvailability(row, 'applyPlan', input.runnerFreshAfter)
      if (availability === 'offline') return { outcome: 'runnerOffline' }
      if (availability === 'capabilityUnavailable') return { outcome: 'capabilityUnavailable' }

      const existing = await client.query<ExistingApplyRow>(
        `SELECT pa.id AS approval_id, pa.consumed_by_job_id AS job_id,
                rd.id AS device_id
         FROM plan_approvals pa
         JOIN project_instances pi
           ON pi.organization_id = pa.organization_id AND pi.id = pa.project_instance_id
         JOIN runner_devices rd
           ON rd.organization_id = pi.organization_id AND rd.id = pi.device_id
         WHERE pa.organization_id = $1 AND pa.source_plan_job_id = $2`,
        [input.actor.organizationId, input.planJobId],
      )
      const existingRow = existing.rows[0]
      if (existingRow?.job_id) {
        return {
          outcome: 'existing',
          jobId: existingRow.job_id,
          approvalId: existingRow.approval_id,
          deviceId: existingRow.device_id,
        }
      }

      await expirePendingSetupOperations(
        client,
        input.actor.organizationId,
        input.projectInstanceId,
        input.issuedAt,
      )
      const activeOperation = await activeSetupOperation(
        client,
        input.actor.organizationId,
        input.projectInstanceId,
      )
      if (activeOperation) return { outcome: 'operationInProgress', activeOperation }

      const approval = {
        approvalId: input.approvalId,
        organizationId: input.actor.organizationId,
        projectInstanceId: input.projectInstanceId,
        setupRevisionId: revision.setupRevisionId,
        planDigest: input.planDigest,
        approvedBy: input.actor.userId,
        approvedAt: input.issuedAt,
        expiresAt: input.expiresAt,
      }
      const job: JobEnvelope = {
        protocolVersion: PROTOCOL_VERSION,
        jobId: input.applyJobId,
        idempotencyKey: `apply-${input.planJobId}`,
        organizationId: input.actor.organizationId,
        deviceId: row.device_id,
        projectInstanceId: input.projectInstanceId,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
        job: {
          kind: 'applyPlan',
          payload: { projectId: row.project_id, revision, approval },
        },
      }
      await insertJob(client, job)
      await client.query(
        `INSERT INTO plan_approvals
         (id, organization_id, project_instance_id, setup_revision_id, plan_digest,
          approved_by, approved_at, expires_at, consumed_by_job_id, source_plan_job_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          approval.approvalId,
          approval.organizationId,
          approval.projectInstanceId,
          approval.setupRevisionId,
          approval.planDigest,
          approval.approvedBy,
          approval.approvedAt,
          approval.expiresAt,
          job.jobId,
          input.planJobId,
        ],
      )
      return {
        outcome: 'queued',
        jobId: job.jobId,
        approvalId: approval.approvalId,
        deviceId: row.device_id,
      }
    })
  }

  async enqueueRollback(input: {
    actor: { organizationId: string; userId: string }
    projectInstanceId: string
    operationId: string
    jobId: string
    issuedAt: string
    expiresAt: string
    runnerFreshAfter: string
  }): Promise<RollbackQueueOutcome> {
    return transaction(this.pool, async (client) => {
      const found = await client.query<ReceiptRow>(
        `SELECT pi.organization_id, pi.project_id, pi.id AS project_instance_id,
                rd.id AS device_id, rd.status AS device_status,
                rd.last_seen_at AS runner_last_seen_at, rd.capabilities,
                receipts.outcome, receipts.recoverability
         FROM project_instances pi
         JOIN runner_devices rd
           ON rd.organization_id = pi.organization_id AND rd.id = pi.device_id
         JOIN operation_receipts receipts
           ON receipts.organization_id = pi.organization_id
             AND receipts.project_instance_id = pi.id AND receipts.operation_id = $3
         WHERE pi.organization_id = $1 AND pi.id = $2
         FOR UPDATE`,
        [input.actor.organizationId, input.projectInstanceId, input.operationId],
      )
      const row = found.rows[0]
      if (!row || !row.outcome) return { outcome: 'receiptMissing' }
      if (row.outcome === 'rolledBack' || row.recoverability !== 'rollbackAvailable') {
        return { outcome: 'notRecoverable' }
      }
      const availability = runnerAvailability(row, 'rollbackOperation', input.runnerFreshAfter)
      if (availability === 'offline') return { outcome: 'runnerOffline' }
      if (availability === 'capabilityUnavailable') return { outcome: 'capabilityUnavailable' }
      const idempotencyKey = `rollback-${input.operationId}`
      const existing = await client.query<QueryResultRow & { id: string }>(
        `SELECT id FROM runner_jobs
         WHERE organization_id = $1 AND device_id = $2 AND idempotency_key = $3`,
        [input.actor.organizationId, row.device_id, idempotencyKey],
      )
      if (existing.rows[0]) {
        return { outcome: 'existing', jobId: existing.rows[0].id, deviceId: row.device_id }
      }
      await expirePendingSetupOperations(
        client,
        input.actor.organizationId,
        input.projectInstanceId,
        input.issuedAt,
      )
      const activeOperation = await activeSetupOperation(
        client,
        input.actor.organizationId,
        input.projectInstanceId,
      )
      if (activeOperation) return { outcome: 'operationInProgress', activeOperation }
      const job: JobEnvelope = {
        protocolVersion: PROTOCOL_VERSION,
        jobId: input.jobId,
        idempotencyKey,
        organizationId: input.actor.organizationId,
        deviceId: row.device_id,
        projectInstanceId: input.projectInstanceId,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
        job: {
          kind: 'rollbackOperation',
          payload: { projectId: row.project_id, operationId: input.operationId },
        },
      }
      await insertJob(client, job)
      return { outcome: 'queued', jobId: job.jobId, deviceId: row.device_id }
    })
  }
}
