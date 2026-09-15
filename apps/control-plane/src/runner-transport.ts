import { publicLibrary } from './library-catalog.js'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { artifactDigest } from './artifact-digest.js'
import { isSkillLibrary } from './skill-library.js'
import type { BrowserAccess } from './development-auth.js'

import {
  PROTOCOL_VERSION, isLibraryRequest, isLibraryMutation, type LibraryRequest,
  type ArtifactBundle,
  type ClaimRunnerJobRequest,
  type AcknowledgeRunnerJobRequest,
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
  type RunnerJobAcknowledgement,
  type RunnerJobControlRequest,
  type RunnerJobControlResponse,
  type RunnerJobStatusResponse,
  type RunnerStatusResponse,
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

export interface JobCompletion {
  outcome: 'accepted' | 'duplicate' | 'conflict' | 'unknown'
}

export interface JobAcknowledgement {
  outcome: 'accepted' | 'duplicate' | 'conflict' | 'unknown'
}

export type JobControlCheck =
  | { outcome: 'available'; cancelRequested: boolean }
  | { outcome: 'conflict' | 'unknown' }

export interface RunnerTransportRepository {
  withActor<T>(actor: RequestActor, access: BrowserAccess, operation: (repository: BrowserRunnerRepository) => Promise<T>): Promise<T>
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
  runnerStatus(organizationId: string, deviceId: string): Promise<RunnerStatusResponse | null>
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
  storeArtifact(
    runner: RunnerAuthentication,
    bundle: ArtifactBundle,
    now: string,
  ): Promise<void>
  loadArtifact(
    runner: RunnerAuthentication,
    contentDigest: string,
  ): Promise<ArtifactBundle | null>
  claimJob(
    runner: RunnerAuthentication,
    supportedKinds: readonly string[],
    capabilities: RunnerCapabilityReport,
    leaseId: string,
    now: string,
    leaseExpiresAt: string,
    skillLibrary?: ClaimRunnerJobRequest['skillLibrary'],
  ): Promise<LeasedRunnerJob | null>
  acknowledgeJob(
    runner: RunnerAuthentication,
    jobId: string,
    leaseId: string,
    requestDigest: string,
    now: string,
  ): Promise<JobAcknowledgement>
  completeJob(
    runner: RunnerAuthentication,
    jobId: string,
    leaseId: string,
    result: ResultEnvelope,
    resultDigest: string,
    now: string,
  ): Promise<JobCompletion>
  jobControl(
    runner: RunnerAuthentication,
    jobId: string,
    leaseId: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<JobControlCheck>
  jobStatus(organizationId: string, jobId: string): Promise<RunnerJobStatusResponse | null>
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
  jobSignal?: JobSignal
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalDigest(value: unknown): string {
  return digest(JSON.stringify(value))
}

function validateArtifactBundle(bundle: ArtifactBundle): void {
  if (!bundle || !/^sha256:[0-9a-f]{64}$/.test(bundle.contentDigest)) {
    throw new RunnerTransportError(400, 'valid artifact content digest is required')
  }
  if (!Array.isArray(bundle.entries) || bundle.entries.length > 5_000) {
    throw new RunnerTransportError(400, 'artifact bundle has too many entries')
  }
  let decodedBytes = 0
  const paths = new Set<string>()
  for (const entry of bundle.entries) {
    if (
      !entry || typeof entry.path !== 'string' ||
      entry.path.length === 0 ||
      entry.path.length > 500 ||
      entry.path.includes('\\') ||
      entry.path.includes(':') ||
      Buffer.from(entry.path).toString('utf8') !== entry.path ||
      [...entry.path].some((char) => char.charCodeAt(0) < 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159)) ||
      entry.path.startsWith('/') ||
      entry.path.split('/').some((part) => part === '' || part === '.' || part === '..' || part === '.git') ||
      paths.has(entry.path)
    ) {
      throw new RunnerTransportError(400, 'artifact bundle contains an invalid path')
    }
    paths.add(entry.path)
    if (entry.kind === 'directory') {
      if (entry.contentBase64 !== null) {
        throw new RunnerTransportError(400, 'artifact directory cannot contain file bytes')
      }
      continue
    }
    if (entry.kind !== 'file' || typeof entry.contentBase64 !== 'string') {
      throw new RunnerTransportError(400, 'artifact entry kind is invalid')
    }
    const bytes = Buffer.from(entry.contentBase64, 'base64')
    if (bytes.toString('base64') !== entry.contentBase64) {
      throw new RunnerTransportError(400, 'artifact file content is not canonical base64')
    }
    decodedBytes += bytes.length
    if (decodedBytes > 10 * 1024 * 1024) {
      throw new RunnerTransportError(413, 'artifact bundle exceeds 10 MiB')
    }
  }
  const directories = new Set(bundle.entries.filter((entry) => entry.kind === 'directory').map((entry) => entry.path))
  for (const entry of bundle.entries) {
    const parts = entry.path.split('/')
    for (let count = 1; count < parts.length; count += 1) {
      if (!directories.has(parts.slice(0, count).join('/'))) {
        throw new RunnerTransportError(400, 'artifact parent directory is missing')
      }
    }
  }
  if (artifactDigest(bundle.entries) !== bundle.contentDigest) {
    throw new RunnerTransportError(400, 'artifact content digest does not match its bytes')
  }
}

export type BrowserRunnerRepository = Pick<RunnerTransportRepository,
  'createEnrollment' | 'enrollmentStatus' | 'runnerStatus' | 'projectInstance' |
  'enqueueJob' | 'jobStatus' | 'requestCancellation' | 'revokeRunner'>

function supportedJobKinds(report: RunnerCapabilityReport): string[] {
  const kinds: string[] = []
  if (report.capabilities.library) kinds.push("libraryAction")
  if (report.capabilities.scanProject) kinds.push('scanProject')
  if (report.capabilities.planSetup) kinds.push('planSetup')
  if (report.capabilities.applyPlan) kinds.push('applyPlan')
  if (report.capabilities.rollbackOperation) kinds.push('rollbackOperation')
  return kinds
}

interface JobWaiter {
  afterGeneration: number
  resolve: () => void
  timeout: ReturnType<typeof setTimeout>
}

export class JobSignal {
  private readonly generations = new Map<string, number>()
  private readonly waiters = new Map<string, Set<JobWaiter>>()

  generation(deviceId: string): number {
    return this.generations.get(deviceId) ?? 0
  }

  notify(deviceId: string): void {
    const generation = this.generation(deviceId) + 1
    this.generations.set(deviceId, generation)
    const waiters = this.waiters.get(deviceId)
    if (!waiters) return
    for (const waiter of [...waiters]) {
      if (waiter.afterGeneration >= generation) continue
      clearTimeout(waiter.timeout)
      waiters.delete(waiter)
      waiter.resolve()
    }
    if (waiters.size === 0) this.waiters.delete(deviceId)
  }

  wait(deviceId: string, afterGeneration: number, waitMs: number): Promise<void> {
    if (waitMs <= 0 || this.generation(deviceId) > afterGeneration) return Promise.resolve()
    return new Promise((resolve) => {
      const waiters = this.waiters.get(deviceId) ?? new Set<JobWaiter>()
      const waiter: JobWaiter = {
        afterGeneration,
        resolve,
        timeout: setTimeout(() => {
          waiters.delete(waiter)
          if (waiters.size === 0) this.waiters.delete(deviceId)
          resolve()
        }, waitMs),
      }
      waiters.add(waiter)
      this.waiters.set(deviceId, waiters)
      if (this.generation(deviceId) > afterGeneration) {
        clearTimeout(waiter.timeout)
        waiters.delete(waiter)
        resolve()
      }
    })
  }
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
  private readonly jobSignal: JobSignal

  constructor(
    private readonly repository: RunnerTransportRepository,
    private readonly options: RunnerTransportServiceOptions,
  ) {
    this.enrollmentTtlMs = options.enrollmentTtlMs ?? 10 * 60_000
    this.jobTtlMs = options.jobTtlMs ?? 5 * 60_000
    this.leaseTtlMs = options.leaseTtlMs ?? 5 * 60_000
    this.now = options.now ?? (() => new Date())
    this.randomId = options.randomId ?? randomUUID
    this.randomSecret =
      options.randomSecret ?? ((bytes) => randomBytes(bytes).toString('base64url'))
    this.jobSignal = options.jobSignal ?? new JobSignal()
  }

  async createEnrollment(actor: RequestActor): Promise<CreateRunnerEnrollmentResponse> {
    const now = this.now()
    const code = this.randomSecret(16)
    const enrollmentId = this.randomId()
    const expiresAt = new Date(now.getTime() + this.enrollmentTtlMs).toISOString()
    await this.repository.withActor(actor, 'write', (repository) => repository.createEnrollment({
      id: enrollmentId,
      organizationId: actor.organizationId,
      createdBy: actor.userId,
      codeHash: digest(code),
      state: 'waiting',
      claimedDeviceId: null,
      createdAt: now.toISOString(),
      expiresAt,
      claimedAt: null,
    }))
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
    const record = await this.repository.withActor(actor, 'read', (repository) => repository.enrollmentStatus(
      actor.organizationId,
      enrollmentId,
      this.now().toISOString(),
    ))
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

  async runnerStatus(actor: RequestActor, deviceId: string): Promise<RunnerStatusResponse> {
    const runner = await this.repository.withActor(actor, 'read', (repository) => repository.runnerStatus(actor.organizationId, deviceId))
    if (!runner) throw new RunnerTransportError(404, 'runner not found')
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

  async catalogue(actor: RequestActor, request: LibraryRequest): Promise<unknown> {
    if (!isLibraryRequest(request) || !['get_featured_skills','search_skills_online','preview_git_skill_cmd'].includes(request.command)) throw new RunnerTransportError(400, 'Invalid catalogue request')
    await this.repository.withActor(actor, 'read', async () => undefined)
    return publicLibrary(request)
  }

  async enqueueLibrary(actor: RequestActor, deviceId: string, request: LibraryRequest): Promise<{ jobId: string }> {
    if (!isLibraryRequest(request) || request.command === 'set_github_token') throw new RunnerTransportError(400, 'Invalid library request')
    const queued = await this.repository.withActor(actor, isLibraryMutation(request.command) ? 'write' : 'read', async (repository) => {
      const runner = await repository.runnerStatus(actor.organizationId, deviceId)
      if (!runner || runner.status !== 'active') throw new RunnerTransportError(404, 'Runner not found')
      if (!runner.capabilities?.capabilities.library) throw new RunnerTransportError(409, 'Update the runner to use the skill library')
      const now = this.now(), jobId = this.randomId()
      await repository.enqueueJob({ protocolVersion: PROTOCOL_VERSION, jobId, idempotencyKey: 'library-' + jobId,
        organizationId: actor.organizationId, deviceId, projectInstanceId: null, issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.jobTtlMs).toISOString(), job: { kind: 'libraryAction', payload: request } })
      return { jobId }
    })
    this.jobSignal.notify(deviceId)
    return queued
  }

  async enqueueScan(
    actor: RequestActor,
    projectInstanceId: string,
    includeUnmanaged: boolean,
  ): Promise<{ jobId: string }> {
    const queued = await this.repository.withActor(actor, 'write', async (repository) => {
      const route = await repository.projectInstance(actor.organizationId, projectInstanceId)
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
      await repository.enqueueJob(job)
      return { jobId, deviceId: route.deviceId }
    })
    this.jobSignal.notify(queued.deviceId)
    return { jobId: queued.jobId }
  }

  async storeArtifact(credential: string, bundle: ArtifactBundle): Promise<void> {
    validateArtifactBundle(bundle)
    const runner = await this.authenticate(credential)
    await this.repository.storeArtifact(runner, bundle, this.now().toISOString())
  }

  async loadArtifact(credential: string, contentDigest: string): Promise<ArtifactBundle> {
    if (!/^sha256:[0-9a-f]{64}$/.test(contentDigest)) {
      throw new RunnerTransportError(400, 'valid artifact content digest is required')
    }
    const runner = await this.authenticate(credential)
    const bundle = await this.repository.loadArtifact(runner, contentDigest)
    if (!bundle) throw new RunnerTransportError(404, 'artifact is not available')
    return bundle
  }

  async claimJob(
    credential: string,
    request: ClaimRunnerJobRequest,
  ): Promise<LeasedRunnerJob | null> {
    validateCapabilities(request.capabilities)
    const runner = await this.authenticate(credential)
    if (request.skillLibrary !== undefined && !isSkillLibrary(request.skillLibrary)) {
      throw new RunnerTransportError(400, 'invalid managed skill inventory')
    }
    const waitMs = Math.min(
      25_000,
      Math.max(0, Number.isFinite(request.waitMs) ? Math.floor(request.waitMs ?? 0) : 0),
    )
    const generation = this.jobSignal.generation(runner.deviceId)
    const claim = () =>
      this.repository.claimJob(
        runner,
        supportedJobKinds(request.capabilities),
        request.capabilities,
        this.randomId(),
        this.now().toISOString(),
        new Date(this.now().getTime() + this.leaseTtlMs).toISOString(),
        request.skillLibrary,
      )
    const immediate = await claim()
    if (immediate || waitMs === 0) return immediate
    await this.jobSignal.wait(runner.deviceId, generation, waitMs)
    return claim()
  }

  notifyJob(deviceId: string): void {
    this.jobSignal.notify(deviceId)
  }

  async acknowledgeJob(
    credential: string,
    jobId: string,
    request: AcknowledgeRunnerJobRequest,
  ): Promise<RunnerJobAcknowledgement> {
    const runner = await this.authenticate(credential)
    if (!/^sha256:[0-9a-f]{64}$/.test(request.requestDigest)) {
      throw new RunnerTransportError(400, 'valid request digest is required')
    }
    const acknowledgement = await this.repository.acknowledgeJob(
      runner,
      jobId,
      request.leaseId,
      request.requestDigest,
      this.now().toISOString(),
    )
    if (acknowledgement.outcome === 'unknown') {
      throw new RunnerTransportError(404, 'runner job not found')
    }
    if (acknowledgement.outcome === 'conflict') {
      throw new RunnerTransportError(409, 'runner job acknowledgement does not match its lease')
    }
    return { accepted: true, duplicate: acknowledgement.outcome === 'duplicate' }
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
      request.result.deviceId !== runner.deviceId ||
      (request.result.projectInstanceId !== null && request.result.projectInstanceId.trim() === '') ||
      request.result.idempotencyKey.trim() === ''
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

  async jobControl(
    credential: string,
    jobId: string,
    request: RunnerJobControlRequest,
  ): Promise<RunnerJobControlResponse> {
    const runner = await this.authenticate(credential)
    if (request.leaseId.trim() === '') {
      throw new RunnerTransportError(400, 'lease id is required')
    }
    const now = this.now()
    const control = await this.repository.jobControl(
      runner,
      jobId,
      request.leaseId,
      now.toISOString(),
      new Date(now.getTime() + this.leaseTtlMs).toISOString(),
    )
    if (control.outcome === 'unknown') {
      throw new RunnerTransportError(404, 'runner job not found')
    }
    if (control.outcome === 'conflict') {
      throw new RunnerTransportError(409, 'runner job control does not match its active lease')
    }
    if (control.outcome !== 'available') {
      throw new RunnerTransportError(409, 'runner job control is unavailable')
    }
    return { cancelRequested: control.cancelRequested }
  }

  async jobStatus(actor: RequestActor, jobId: string): Promise<RunnerJobStatusResponse> {
    const status = await this.repository.withActor(actor, 'read', (repository) => repository.jobStatus(actor.organizationId, jobId))
    if (!status) throw new RunnerTransportError(404, 'runner job not found')
    return status
  }

  async cancelJob(actor: RequestActor, jobId: string): Promise<void> {
    if (
      !(await this.repository.withActor(actor, 'write', (repository) => repository.requestCancellation(
        actor.organizationId,
        jobId,
        this.now().toISOString(),
      )))
    ) {
      throw new RunnerTransportError(404, 'cancellable runner job not found')
    }
  }

  async revokeRunner(actor: RequestActor, deviceId: string): Promise<void> {
    if (!(await this.repository.withActor(actor, 'write', (repository) => repository.revokeRunner(actor.organizationId, deviceId)))) {
      throw new RunnerTransportError(404, 'runner not found')
    }
  }
}
