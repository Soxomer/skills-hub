import type {
  JobEnvelope,
  LeasedRunnerJob,
  RegisterProjectInstanceRequest,
  ResultEnvelope,
  RunnerCapabilityReport,
  RunnerJobStatusResponse,
  RunnerStatusResponse,
} from '@ahm/contracts'

import type {
  JobCompletion,
  ProjectInstanceRoute,
  RunnerAuthentication,
  RunnerDeviceRegistration,
  RunnerEnrollmentRecord,
  RunnerTransportRepository,
} from './runner-transport.js'

interface MemoryDevice extends RunnerAuthentication {
  label: string
  credentialHash: string
  capabilities: RunnerCapabilityReport
  enrolledAt: string
  lastSeenAt: string | null
}

interface MemoryJob {
  envelope: JobEnvelope
  state: RunnerJobStatusResponse['state']
  leaseId: string | null
  leaseExpiresAt: string | null
  attemptCount: number
  cancelRequestedAt: string | null
  result: ResultEnvelope | null
  resultDigest: string | null
}

interface MemoryProjectInstance extends ProjectInstanceRoute {
  registeredAt: string
  lastSeenAt: string | null
}

export class InMemoryRunnerTransportRepository implements RunnerTransportRepository {
  private readonly enrollments = new Map<string, RunnerEnrollmentRecord>()
  private readonly enrollmentByCode = new Map<string, string>()
  private readonly devices = new Map<string, MemoryDevice>()
  private readonly deviceByCredential = new Map<string, string>()
  private readonly projects = new Map<string, string>()
  private readonly projectInstances = new Map<string, MemoryProjectInstance>()
  private readonly jobs = new Map<string, MemoryJob>()

  seedProject(organizationId: string, projectId: string): void {
    this.projects.set(`${organizationId}:${projectId}`, projectId)
  }

  async createEnrollment(record: RunnerEnrollmentRecord): Promise<void> {
    this.enrollments.set(record.id, { ...record })
    this.enrollmentByCode.set(record.codeHash, record.id)
  }

  async enrollmentStatus(
    organizationId: string,
    enrollmentId: string,
    now: string,
  ): Promise<RunnerEnrollmentRecord | null> {
    const record = this.enrollments.get(enrollmentId)
    if (!record || record.organizationId !== organizationId) return null
    if (record.state === 'waiting' && record.expiresAt <= now) record.state = 'expired'
    return { ...record }
  }

  async claimEnrollment(
    codeHash: string,
    device: RunnerDeviceRegistration,
    now: string,
  ): Promise<RunnerAuthentication | null> {
    const enrollmentId = this.enrollmentByCode.get(codeHash)
    const enrollment = enrollmentId ? this.enrollments.get(enrollmentId) : undefined
    if (!enrollment || enrollment.state !== 'waiting') return null
    if (enrollment.expiresAt <= now) {
      enrollment.state = 'expired'
      return null
    }
    const authentication: RunnerAuthentication = {
      organizationId: enrollment.organizationId,
      deviceId: device.id,
      status: 'active',
    }
    this.devices.set(device.id, {
      ...authentication,
      label: device.label,
      credentialHash: device.credentialHash,
      capabilities: device.capabilities,
      enrolledAt: device.enrolledAt,
      lastSeenAt: null,
    })
    this.deviceByCredential.set(device.credentialHash, device.id)
    enrollment.state = 'claimed'
    enrollment.claimedDeviceId = device.id
    enrollment.claimedAt = now
    return authentication
  }

  async authenticateRunner(credentialHash: string): Promise<RunnerAuthentication | null> {
    const deviceId = this.deviceByCredential.get(credentialHash)
    const device = deviceId ? this.devices.get(deviceId) : undefined
    return device
      ? {
          organizationId: device.organizationId,
          deviceId: device.deviceId,
          status: device.status,
        }
      : null
  }

  async runnerStatus(
    organizationId: string,
    deviceId: string,
  ): Promise<RunnerStatusResponse | null> {
    const device = this.devices.get(deviceId)
    if (!device || device.organizationId !== organizationId) return null
    return {
      deviceId: device.deviceId,
      label: device.label,
      status: device.status,
      enrolledAt: device.enrolledAt,
      lastSeenAt: device.lastSeenAt,
      capabilities: device.capabilities,
      projectInstances: [...this.projectInstances.values()]
        .filter(
          (instance) =>
            instance.organizationId === organizationId && instance.deviceId === deviceId,
        )
        .sort((left, right) => left.registeredAt.localeCompare(right.registeredAt))
        .map((instance) => ({
          projectInstanceId: instance.projectInstanceId,
          projectId: instance.projectId,
          registeredAt: instance.registeredAt,
          lastSeenAt: instance.lastSeenAt,
        })),
    }
  }

  async registerProjectInstance(
    runner: RunnerAuthentication,
    request: RegisterProjectInstanceRequest,
    now: string,
  ): Promise<boolean> {
    if (!this.projects.has(`${runner.organizationId}:${request.projectId}`)) return false
    const current = this.projectInstances.get(request.projectInstanceId)
    if (
      current &&
      (current.organizationId !== runner.organizationId || current.deviceId !== runner.deviceId)
    ) {
      return false
    }
    this.projectInstances.set(request.projectInstanceId, {
      organizationId: runner.organizationId,
      projectInstanceId: request.projectInstanceId,
      projectId: request.projectId,
      deviceId: runner.deviceId,
      registeredAt: current?.registeredAt ?? now,
      lastSeenAt: now,
    })
    return true
  }

  async projectInstance(
    organizationId: string,
    projectInstanceId: string,
  ): Promise<ProjectInstanceRoute | null> {
    const route = this.projectInstances.get(projectInstanceId)
    return route?.organizationId === organizationId
      ? {
          organizationId: route.organizationId,
          projectInstanceId: route.projectInstanceId,
          projectId: route.projectId,
          deviceId: route.deviceId,
        }
      : null
  }

  async enqueueJob(job: JobEnvelope): Promise<void> {
    this.jobs.set(job.jobId, {
      envelope: job,
      state: 'pending',
      leaseId: null,
      leaseExpiresAt: null,
      attemptCount: 0,
      cancelRequestedAt: null,
      result: null,
      resultDigest: null,
    })
  }

  async claimJob(
    runner: RunnerAuthentication,
    supportedKinds: readonly string[],
    capabilities: RunnerCapabilityReport,
    leaseId: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<LeasedRunnerJob | null> {
    const device = this.devices.get(runner.deviceId)
    if (device) {
      device.capabilities = capabilities
      device.lastSeenAt = now
    }
    for (const job of this.jobs.values()) {
      if (
        job.envelope.deviceId === runner.deviceId &&
        job.state === 'leased' &&
        job.leaseExpiresAt !== null &&
        job.leaseExpiresAt > now &&
        supportedKinds.includes(job.envelope.job.kind)
      ) {
        return this.leasedJob(job)
      }
    }
    const candidates = [...this.jobs.values()].sort((left, right) =>
      left.envelope.issuedAt.localeCompare(right.envelope.issuedAt),
    )
    for (const job of candidates) {
      if (job.envelope.expiresAt <= now && ['pending', 'leased'].includes(job.state)) {
        job.state = 'expired'
        continue
      }
      const available =
        job.state === 'pending' ||
        (job.state === 'leased' && job.leaseExpiresAt !== null && job.leaseExpiresAt <= now)
      if (
        !available ||
        job.envelope.deviceId !== runner.deviceId ||
        !supportedKinds.includes(job.envelope.job.kind)
      ) {
        continue
      }
      job.state = 'leased'
      job.leaseId = leaseId
      job.leaseExpiresAt = leaseExpiresAt
      job.attemptCount += 1
      return this.leasedJob(job)
    }
    return null
  }

  async completeJob(
    runner: RunnerAuthentication,
    jobId: string,
    leaseId: string,
    result: ResultEnvelope,
    resultDigest: string,
  ): Promise<JobCompletion> {
    const job = this.jobs.get(jobId)
    if (
      !job ||
      job.envelope.organizationId !== runner.organizationId ||
      job.envelope.deviceId !== runner.deviceId
    ) {
      return { outcome: 'unknown' }
    }
    if (job.resultDigest !== null) {
      return { outcome: job.resultDigest === resultDigest ? 'duplicate' : 'conflict' }
    }
    if (job.leaseId !== leaseId || job.state !== 'leased') return { outcome: 'conflict' }
    job.result = result
    job.resultDigest = resultDigest
    job.state =
      result.result.kind === 'error' && result.result.payload.code === 'jobCancelled'
        ? 'cancelled'
        : result.result.kind === 'error'
          ? 'failed'
          : 'succeeded'
    return { outcome: 'accepted' }
  }

  async jobStatus(
    organizationId: string,
    jobId: string,
  ): Promise<RunnerJobStatusResponse | null> {
    const job = this.jobs.get(jobId)
    if (!job || job.envelope.organizationId !== organizationId) return null
    return {
      jobId,
      state: job.state,
      result: job.result,
      cancelRequested: job.cancelRequestedAt !== null,
    }
  }

  async requestCancellation(
    organizationId: string,
    jobId: string,
    now: string,
  ): Promise<boolean> {
    const job = this.jobs.get(jobId)
    if (!job || job.envelope.organizationId !== organizationId) return false
    if (job.state === 'pending') {
      job.cancelRequestedAt = now
      job.state = 'cancelled'
      return true
    }
    if (job.state === 'leased') {
      job.cancelRequestedAt = now
      return true
    }
    return false
  }

  async revokeRunner(organizationId: string, deviceId: string): Promise<boolean> {
    const device = this.devices.get(deviceId)
    if (!device || device.organizationId !== organizationId) return false
    device.status = 'revoked'
    return true
  }

  private leasedJob(job: MemoryJob): LeasedRunnerJob {
    return {
      leaseId: job.leaseId as string,
      leaseExpiresAt: job.leaseExpiresAt as string,
      cancelRequested: job.cancelRequestedAt !== null,
      job: job.envelope,
    }
  }
}
