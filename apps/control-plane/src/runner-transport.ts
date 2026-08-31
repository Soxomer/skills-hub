import { createHash, randomBytes, randomUUID } from 'node:crypto'

import {
  PROTOCOL_VERSION,
  type ClaimRunnerJobRequest,
  type CreateRunnerEnrollmentResponse,
  type EnrollRunnerRequest,
  type EnrollRunnerResponse,
  type JobEnvelope,
  type LeasedRunnerJob,
  type RegisterProjectInstanceRequest,
  type ResultEnvelope,
  type RunnerCapabilityReport,
  type RunnerEnrollmentStatus,
  type RunnerResultAcknowledgement,
  type SubmitRunnerResultRequest,
} from '@ahm/contracts'

export interface RequestActor {
  organizationId: string
  userId: string
}

export interface RunnerAuthentication {
  organizationId: string
  deviceId: string
  status: 'active' | 'revoked'
}

export interface RunnerEnrollmentRecord {
  id: string
  organizationId: string
  createdBy: string
  codeHash: string
  state: 'waiting' | 'claimed' | 'expired'
  claimedDeviceId: string | null
  createdAt: string
  expiresAt: string
  claimedAt: string | null
}

export interface RunnerDeviceRegistration {
  id: string
  label: string
  credentialHash: string
  capabilities: RunnerCapabilityReport
  enrolledAt: string
}

export interface ProjectInstanceRoute {
  organizationId: string
  projectInstanceId: string
  projectId: string
  deviceId: string
}

export interface RunnerJobStatus {
  jobId: string
  state: 'pending' | 'leased' | 'succeeded' | 'failed' | 'expired' | 'cancelled'
  result: ResultEnvelope | null
  cancelRequested: boolean
}

export interface JobCompletion {
  outcome: 'accepted' | 'duplicate' | 'conflict' | 'unknown'
}

export interface RunnerTransportRepository {
  createEnrollment(record: RunnerEnrollmentRecord): Promise<void>
  enrollmentStatus(
    organizationId: string,
    enrollmentId: string,
    now: string,
  ): Promise<RunnerEnrollmentRecord | null>
  claimEnrollment(
    codeHash: string,
    device: RunnerDeviceRegistration,
    now: string,
  ): Promise<RunnerAuthentication | null>
  authenticateRunner(credentialHash: string): Promise<RunnerAuthentication | null>
  registerProjectInstance(
    runner: RunnerAuthentication,
    request: RegisterProjectInstanceRequest,
    now: string,
  ): Promise<boolean>
  projectInstance(
    organizationId: string,
    projectInstanceId: string,
  ): Promise<ProjectInstanceRoute | null>
  enqueueJob(job: JobEnvelope): Promise<void>
  claimJob(
    runner: RunnerAuthentication,
    supportedKinds: readonly string[],
    capabilities: RunnerCapabilityReport,
    leaseId: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<LeasedRunnerJob | null>
  completeJob(
    runner: RunnerAuthentication,
    jobId: string,
    leaseId: string,
    result: ResultEnvelope,
    resultDigest: string,
    now: string,
  ): Promise<JobCompletion>
  jobStatus(organizationId: string, jobId: string): Promise<RunnerJobStatus | null>
  requestCancellation(organizationId: string, jobId: string, now: string): Promise<boolean>
  revokeRunner(organizationId: string, deviceId: string): Promise<boolean>
}

export class RunnerTransportError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
    this.name = 'RunnerTransportError'
  }
}

export interface RunnerTransportServiceOptions {
  serverUrl: string
  enrollmentTtlMs?: number
  jobTtlMs?: number
  leaseTtlMs?: number
  now?: () => Date
  randomId?: () => string
  randomSecret?: (bytes: number) => string
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalDigest(value: unknown): string {
  return digest(JSON.stringify(value))
}

function supportedJobKinds(report: RunnerCapabilityReport): string[] {
  const kinds: string[] = []
  if (report.capabilities.scanProject) kinds.push('scanProject')
  return kinds
}

function validateCapabilities(report: RunnerCapabilityReport): void {
  if (
    report.protocolVersion !== PROTOCOL_VERSION ||
    !report.supportedProtocolVersions.includes(PROTOCOL_VERSION)
  ) {
    throw new RunnerTransportError(409, 'runner does not support protocol 1.0')
  }
}

export class RunnerTransportService {
  private readonly enrollmentTtlMs: number
  private readonly jobTtlMs: number
  private readonly leaseTtlMs: number
  private readonly now: () => Date
  private readonly randomId: () => string
  private readonly randomSecret: (bytes: number) => string

  constructor(
    private readonly repository: RunnerTransportRepository,
    private readonly options: RunnerTransportServiceOptions,
  ) {
    this.enrollmentTtlMs = options.enrollmentTtlMs ?? 10 * 60_000
    this.jobTtlMs = options.jobTtlMs ?? 5 * 60_000
    this.leaseTtlMs = options.leaseTtlMs ?? 60_000
    this.now = options.now ?? (() => new Date())
    this.randomId = options.randomId ?? randomUUID
    this.randomSecret =
      options.randomSecret ?? ((bytes) => randomBytes(bytes).toString('base64url'))
  }

  async createEnrollment(actor: RequestActor): Promise<CreateRunnerEnrollmentResponse> {
    const now = this.now()
    const code = this.randomSecret(16)
    const enrollmentId = this.randomId()
    const expiresAt = new Date(now.getTime() + this.enrollmentTtlMs).toISOString()
    await this.repository.createEnrollment({
      id: enrollmentId,
      organizationId: actor.organizationId,
      createdBy: actor.userId,
      codeHash: digest(code),
      state: 'waiting',
      claimedDeviceId: null,
      createdAt: now.toISOString(),
      expiresAt,
      claimedAt: null,
    })
    return {
      enrollmentId,
      code,
      expiresAt,
      command: `ahm connect ${code} --server ${this.options.serverUrl}`,
    }
  }

  async enrollmentStatus(
    actor: RequestActor,
    enrollmentId: string,
  ): Promise<RunnerEnrollmentStatus> {
    const record = await this.repository.enrollmentStatus(
      actor.organizationId,
      enrollmentId,
      this.now().toISOString(),
    )
    if (!record) throw new RunnerTransportError(404, 'runner enrollment not found')
    return {
      enrollmentId: record.id,
      state: record.state,
      deviceId: record.claimedDeviceId,
      expiresAt: record.expiresAt,
    }
  }

  async enroll(request: EnrollRunnerRequest): Promise<EnrollRunnerResponse> {
    validateCapabilities(request.capabilities)
    const now = this.now().toISOString()
    const deviceId = this.randomId()
    const credential = this.randomSecret(32)
    const runner = await this.repository.claimEnrollment(
      digest(request.code),
      {
        id: deviceId,
        label: request.label.trim() || 'Local runner',
        credentialHash: digest(credential),
        capabilities: request.capabilities,
        enrolledAt: now,
      },
      now,
    )
    if (!runner) {
      throw new RunnerTransportError(404, 'enrollment code is invalid, expired, or used')
    }
    return { organizationId: runner.organizationId, deviceId, credential }
  }

  async authenticate(credential: string): Promise<RunnerAuthentication> {
    const runner = await this.repository.authenticateRunner(digest(credential))
    if (!runner || runner.status !== 'active') {
      throw new RunnerTransportError(401, 'runner credential is invalid or revoked')
    }
    return runner
  }

  async registerProjectInstance(
    credential: string,
    request: RegisterProjectInstanceRequest,
  ): Promise<void> {
    const runner = await this.authenticate(credential)
    const registered = await this.repository.registerProjectInstance(
      runner,
      request,
      this.now().toISOString(),
    )
    if (!registered) throw new RunnerTransportError(404, 'logical project not found')
  }

  async enqueueScan(
    actor: RequestActor,
    projectInstanceId: string,
    includeUnmanaged: boolean,
  ): Promise<{ jobId: string }> {
    const route = await this.repository.projectInstance(actor.organizationId, projectInstanceId)
    if (!route) throw new RunnerTransportError(404, 'project instance not found')
    const now = this.now()
    const jobId = this.randomId()
    const job: JobEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      jobId,
      idempotencyKey: `scan-${jobId}`,
      organizationId: actor.organizationId,
      deviceId: route.deviceId,
      projectInstanceId: route.projectInstanceId,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.jobTtlMs).toISOString(),
      job: {
        kind: 'scanProject',
        payload: { projectId: route.projectId, includeUnmanaged },
      },
    }
    await this.repository.enqueueJob(job)
    return { jobId }
  }

  async claimJob(
    credential: string,
    request: ClaimRunnerJobRequest,
  ): Promise<LeasedRunnerJob | null> {
    validateCapabilities(request.capabilities)
    const runner = await this.authenticate(credential)
    const now = this.now()
    return this.repository.claimJob(
      runner,
      supportedJobKinds(request.capabilities),
      request.capabilities,
      this.randomId(),
      now.toISOString(),
      new Date(now.getTime() + this.leaseTtlMs).toISOString(),
    )
  }

  async submitResult(
    credential: string,
    jobId: string,
    request: SubmitRunnerResultRequest,
  ): Promise<RunnerResultAcknowledgement> {
    const runner = await this.authenticate(credential)
    if (
      request.result.jobId !== jobId ||
      request.result.organizationId !== runner.organizationId ||
      request.result.deviceId !== runner.deviceId
    ) {
      throw new RunnerTransportError(409, 'result identity does not match its lease')
    }
    const completion = await this.repository.completeJob(
      runner,
      jobId,
      request.leaseId,
      request.result,
      canonicalDigest(request.result),
      this.now().toISOString(),
    )
    if (completion.outcome === 'unknown') {
      throw new RunnerTransportError(404, 'runner job not found')
    }
    if (completion.outcome === 'conflict') {
      throw new RunnerTransportError(409, 'job already has a different terminal result')
    }
    return { accepted: true, duplicate: completion.outcome === 'duplicate' }
  }

  async jobStatus(actor: RequestActor, jobId: string): Promise<RunnerJobStatus> {
    const status = await this.repository.jobStatus(actor.organizationId, jobId)
    if (!status) throw new RunnerTransportError(404, 'runner job not found')
    return status
  }

  async cancelJob(actor: RequestActor, jobId: string): Promise<void> {
    if (
      !(await this.repository.requestCancellation(
        actor.organizationId,
        jobId,
        this.now().toISOString(),
      ))
    ) {
      throw new RunnerTransportError(404, 'cancellable runner job not found')
    }
  }

  async revokeRunner(actor: RequestActor, deviceId: string): Promise<void> {
    if (!(await this.repository.revokeRunner(actor.organizationId, deviceId))) {
      throw new RunnerTransportError(404, 'runner not found')
    }
  }
}
