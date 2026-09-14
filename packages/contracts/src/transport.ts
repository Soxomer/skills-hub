import type {
  JobEnvelope,
  OrganizationId,
  ProjectId,
  ProjectInstanceId,
  ResultEnvelope,
  ProtocolVersion,
  RunnerCapabilities,
} from './protocol.js'

export interface RunnerJobStatusResponse {
  jobId: string
  state:
    | 'pending'
    | 'leased'
    | 'acknowledged'
    | 'succeeded'
    | 'failed'
    | 'expired'
    | 'cancelled'
  result: ResultEnvelope | null
  cancelRequested: boolean
}

export interface RunnerCapabilityReport {
  protocolVersion: ProtocolVersion
  supportedProtocolVersions: ProtocolVersion[]
  runnerVersion: string
  capabilities: RunnerCapabilities
}

export interface CreateRunnerEnrollmentResponse {
  enrollmentId: string
  code: string
  expiresAt: string
  command: string
}

export interface RunnerEnrollmentStatus {
  enrollmentId: string
  state: 'waiting' | 'claimed' | 'expired'
  deviceId: string | null
  expiresAt: string
}

export interface RunnerProjectInstanceSummary {
  projectInstanceId: ProjectInstanceId
  projectId: ProjectId
  registeredAt: string
  lastSeenAt: string | null
}

export interface RunnerStatusResponse {
  skillLibrary?: { reportedAt: string; skills: ManagedSkillSummary[] } | null
  deviceId: string
  label: string
  status: 'active' | 'revoked'
  enrolledAt: string
  lastSeenAt: string | null
  capabilities: RunnerCapabilityReport | null
  projectInstances: RunnerProjectInstanceSummary[]
}

export interface EnrollRunnerRequest {
  code: string
  label: string
  capabilities: RunnerCapabilityReport
}

export interface EnrollRunnerResponse {
  organizationId: OrganizationId
  deviceId: string
  credential: string
}

export interface RegisterProjectInstanceRequest {
  projectInstanceId: ProjectInstanceId
  projectId: ProjectId
}

export interface ClaimRunnerJobRequest {
  skillLibrary?: ManagedSkillSummary[]
  capabilities: RunnerCapabilityReport
  waitMs?: number
}

/** Runner-owned inventory projection. Never includes workstation paths or source credentials. */
export interface ManagedSkillSummary {
  id: string
  name: string
  sourceType: string
  enabled: boolean
  tags: string[]
  targets: { tool: string; scope: 'global' | 'project' }[]
}

export interface LeasedRunnerJob {
  leaseId: string
  leaseExpiresAt: string
  cancelRequested: boolean
  job: JobEnvelope
}

export interface SubmitRunnerResultRequest {
  leaseId: string
  result: ResultEnvelope
}

export interface RunnerJobControlRequest {
  leaseId: string
}

export interface RunnerJobControlResponse {
  cancelRequested: boolean
}

export interface AcknowledgeRunnerJobRequest {
  leaseId: string
  requestDigest: string
}

export interface RunnerJobAcknowledgement {
  accepted: true
  duplicate: boolean
}

export interface RunnerResultAcknowledgement {
  accepted: true
  duplicate: boolean
}

export interface ArtifactBundleEntry {
  path: string
  kind: 'directory' | 'file'
  contentBase64: string | null
}

export interface ArtifactBundle {
  contentDigest: string
  entries: ArtifactBundleEntry[]
}
