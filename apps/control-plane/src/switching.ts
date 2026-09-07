import { randomUUID } from 'node:crypto'

import {
  PROTOCOL_VERSION,
  type ApplyReviewedPlanRequest,
  type ApplyReviewedPlanResponse,
  type JobEnvelope,
  type PortableSetupRevision,
  type ProjectActiveOperation,
  type ProjectInstanceOperationsResponse,
  type ProjectSetupStateResponse,
  type QueuedRunnerJobResponse,
  type RequestSetupPlanRequest,
  type RollbackOperationRequest,
  type RunnerCapabilityReport,
} from '@ahm/contracts'

import type { RequestActor, RunnerTransportService } from './runner-transport.js'

export interface SwitchingRoute {
  organizationId: string
  projectId: string
  projectInstanceId: string
  deviceId: string
  deviceStatus: 'active' | 'revoked'
  runnerLastSeenAt: string | null
  capabilities: RunnerCapabilityReport['capabilities'] | null
}

export interface SetupRevisionContext {
  route: SwitchingRoute
  revision: PortableSetupRevision
}

export type PlanQueueOutcome =
  | { outcome: 'queued'; jobId: string; deviceId: string }
  | { outcome: 'operationInProgress'; activeOperation: ProjectActiveOperation }

export type ApplyQueueOutcome =
  | { outcome: 'queued' | 'existing'; jobId: string; approvalId: string; deviceId: string }
  | { outcome: 'planMissing' }
  | { outcome: 'planNotReady' }
  | { outcome: 'planMismatch' }
  | { outcome: 'planHasConflicts' }
  | { outcome: 'runnerOffline' }
  | { outcome: 'capabilityUnavailable' }
  | { outcome: 'operationInProgress'; activeOperation: ProjectActiveOperation }

export type RollbackQueueOutcome =
  | { outcome: 'queued' | 'existing'; jobId: string; deviceId: string }
  | { outcome: 'receiptMissing' }
  | { outcome: 'notRecoverable' }
  | { outcome: 'runnerOffline' }
  | { outcome: 'capabilityUnavailable' }
  | { outcome: 'operationInProgress'; activeOperation: ProjectActiveOperation }

export interface SwitchingRepository {
  projectSetupState(
    organizationId: string,
    projectId: string,
  ): Promise<ProjectSetupStateResponse | null>
  projectInstanceOperations(
    organizationId: string,
    projectInstanceId: string,
  ): Promise<ProjectInstanceOperationsResponse | null>
  revisionContext(
    organizationId: string,
    projectInstanceId: string,
    setupRevisionId: string,
  ): Promise<SetupRevisionContext | null>
  enqueuePlan(job: JobEnvelope): Promise<PlanQueueOutcome>
  approveAndEnqueueApply(input: {
    actor: RequestActor
    projectInstanceId: string
    planJobId: string
    planDigest: string
    approvalId: string
    applyJobId: string
    issuedAt: string
    expiresAt: string
    runnerFreshAfter: string
  }): Promise<ApplyQueueOutcome>
  enqueueRollback(input: {
    actor: RequestActor
    projectInstanceId: string
    operationId: string
    jobId: string
    issuedAt: string
    expiresAt: string
    runnerFreshAfter: string
  }): Promise<RollbackQueueOutcome>
}

export type SwitchingErrorCode =
  | 'invalidRequest'
  | 'projectNotFound'
  | 'projectInstanceNotFound'
  | 'setupRevisionNotFound'
  | 'runnerOffline'
  | 'runnerCapabilityUnavailable'
  | 'planNotFound'
  | 'planNotReady'
  | 'planDigestMismatch'
  | 'planHasConflicts'
  | 'receiptNotFound'
  | 'rollbackUnavailable'
  | 'projectOperationInProgress'

export interface SwitchingErrorDetails {
  activeOperation: ProjectActiveOperation
}

export class SwitchingError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: SwitchingErrorCode,
    message: string,
    readonly details?: SwitchingErrorDetails,
  ) {
    super(message)
    this.name = 'SwitchingError'
  }
}

export interface SwitchingServiceOptions {
  now?: () => Date
  randomId?: () => string
  jobTtlMs?: number
  interactiveJobTtlMs?: number
  runnerFreshnessMs?: number
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200) {
    throw new SwitchingError(400, 'invalidRequest', `${label} is required`)
  }
  return value.trim()
}

export class SwitchingService {
  private readonly now: () => Date
  private readonly randomId: () => string
  private readonly jobTtlMs: number
  private readonly interactiveJobTtlMs: number
  private readonly runnerFreshnessMs: number

  constructor(
    private readonly repository: SwitchingRepository,
    private readonly transport: RunnerTransportService,
    options: SwitchingServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.randomId = options.randomId ?? randomUUID
    this.jobTtlMs = options.jobTtlMs ?? 5 * 60_000
    this.interactiveJobTtlMs = options.interactiveJobTtlMs ?? 30_000
    this.runnerFreshnessMs = options.runnerFreshnessMs ?? 45_000
  }

  async projectSetupState(
    actor: RequestActor,
    projectId: string,
  ): Promise<ProjectSetupStateResponse> {
    const state = await this.repository.projectSetupState(
      actor.organizationId,
      requireIdentifier(projectId, 'project ID'),
    )
    if (!state) throw new SwitchingError(404, 'projectNotFound', 'project was not found')
    return state
  }

  async projectInstanceOperations(
    actor: RequestActor,
    projectInstanceId: string,
  ): Promise<ProjectInstanceOperationsResponse> {
    const history = await this.repository.projectInstanceOperations(
      actor.organizationId,
      requireIdentifier(projectInstanceId, 'project instance ID'),
    )
    if (!history) {
      throw new SwitchingError(
        404,
        'projectInstanceNotFound',
        'project instance was not found',
      )
    }
    return history
  }

  async requestPlan(
    actor: RequestActor,
    projectInstanceId: string,
    request: RequestSetupPlanRequest,
  ): Promise<QueuedRunnerJobResponse> {
    const revisionId = requireIdentifier(request?.setupRevisionId, 'Setup revision ID')
    const context = await this.repository.revisionContext(
      actor.organizationId,
      requireIdentifier(projectInstanceId, 'project instance ID'),
      revisionId,
    )
    if (!context) {
      throw new SwitchingError(
        404,
        'setupRevisionNotFound',
        'project instance or Setup revision was not found',
      )
    }
    this.requireAvailable(context.route, 'planSetup')
    const now = this.now()
    const jobId = `job_${this.randomId()}`
    const job: JobEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      jobId,
      idempotencyKey: `plan-${jobId}`,
      organizationId: actor.organizationId,
      deviceId: context.route.deviceId,
      projectInstanceId: context.route.projectInstanceId,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.jobTtlMs).toISOString(),
      job: {
        kind: 'planSetup',
        payload: { projectId: context.route.projectId, revision: context.revision },
      },
    }
    const outcome = await this.repository.enqueuePlan(job)
    if (outcome.outcome === 'operationInProgress') {
      throw new SwitchingError(
        409,
        'projectOperationInProgress',
        'another Setup operation is already in progress for this project checkout',
        { activeOperation: outcome.activeOperation },
      )
    }
    this.transport.notifyJob(outcome.deviceId)
    return { jobId: outcome.jobId }
  }

  async applyReviewedPlan(
    actor: RequestActor,
    projectInstanceId: string,
    request: ApplyReviewedPlanRequest,
  ): Promise<ApplyReviewedPlanResponse> {
    const now = this.now()
    const outcome = await this.repository.approveAndEnqueueApply({
      actor,
      projectInstanceId: requireIdentifier(projectInstanceId, 'project instance ID'),
      planJobId: requireIdentifier(request?.planJobId, 'plan job ID'),
      planDigest: requireIdentifier(request?.planDigest, 'plan digest'),
      approvalId: `approval_${this.randomId()}`,
      applyJobId: `job_${this.randomId()}`,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.interactiveJobTtlMs).toISOString(),
      runnerFreshAfter: new Date(now.getTime() - this.runnerFreshnessMs).toISOString(),
    })
    if (outcome.outcome === 'planMissing') {
      throw new SwitchingError(404, 'planNotFound', 'reviewed plan was not found')
    }
    if (outcome.outcome === 'planNotReady') {
      throw new SwitchingError(409, 'planNotReady', 'reviewed plan is not complete')
    }
    if (outcome.outcome === 'planMismatch') {
      throw new SwitchingError(409, 'planDigestMismatch', 'reviewed plan digest changed')
    }
    if (outcome.outcome === 'planHasConflicts') {
      throw new SwitchingError(409, 'planHasConflicts', 'resolve plan conflicts before applying')
    }
    if (outcome.outcome === 'runnerOffline') {
      throw new SwitchingError(409, 'runnerOffline', 'local runner is offline')
    }
    if (outcome.outcome === 'capabilityUnavailable') {
      throw new SwitchingError(
        409,
        'runnerCapabilityUnavailable',
        'local runner does not support applyPlan',
      )
    }
    if (outcome.outcome === 'operationInProgress') {
      throw new SwitchingError(
        409,
        'projectOperationInProgress',
        'another Setup operation is already in progress for this project checkout',
        { activeOperation: outcome.activeOperation },
      )
    }
    this.transport.notifyJob(outcome.deviceId)
    return { jobId: outcome.jobId, approvalId: outcome.approvalId }
  }

  async requestRollback(
    actor: RequestActor,
    projectInstanceId: string,
    request: RollbackOperationRequest,
  ): Promise<QueuedRunnerJobResponse> {
    const now = this.now()
    const outcome = await this.repository.enqueueRollback({
      actor,
      projectInstanceId: requireIdentifier(projectInstanceId, 'project instance ID'),
      operationId: requireIdentifier(request?.operationId, 'operation ID'),
      jobId: `job_${this.randomId()}`,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.interactiveJobTtlMs).toISOString(),
      runnerFreshAfter: new Date(now.getTime() - this.runnerFreshnessMs).toISOString(),
    })
    if (outcome.outcome === 'receiptMissing') {
      throw new SwitchingError(404, 'receiptNotFound', 'operation receipt was not found')
    }
    if (outcome.outcome === 'notRecoverable') {
      throw new SwitchingError(409, 'rollbackUnavailable', 'operation cannot be rolled back')
    }
    if (outcome.outcome === 'runnerOffline') {
      throw new SwitchingError(409, 'runnerOffline', 'local runner is offline')
    }
    if (outcome.outcome === 'capabilityUnavailable') {
      throw new SwitchingError(
        409,
        'runnerCapabilityUnavailable',
        'local runner does not support rollbackOperation',
      )
    }
    if (outcome.outcome === 'operationInProgress') {
      throw new SwitchingError(
        409,
        'projectOperationInProgress',
        'another Setup operation is already in progress for this project checkout',
        { activeOperation: outcome.activeOperation },
      )
    }
    this.transport.notifyJob(outcome.deviceId)
    return { jobId: outcome.jobId }
  }

  private requireAvailable(route: SwitchingRoute, capability: keyof RunnerCapabilityReport['capabilities']): void {
    const lastSeen = route.runnerLastSeenAt ? Date.parse(route.runnerLastSeenAt) : Number.NaN
    if (
      route.deviceStatus !== 'active' ||
      !Number.isFinite(lastSeen) ||
      this.now().getTime() - lastSeen > this.runnerFreshnessMs
    ) {
      throw new SwitchingError(409, 'runnerOffline', 'local runner is offline')
    }
    if (!route.capabilities?.[capability]) {
      throw new SwitchingError(
        409,
        'runnerCapabilityUnavailable',
        `local runner does not support ${capability}`,
      )
    }
  }
}
