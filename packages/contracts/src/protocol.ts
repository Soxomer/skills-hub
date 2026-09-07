export const PROTOCOL_VERSION = '1.0' as const
export const SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_VERSION] as const

export type ProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number]
export type OrganizationId = string
export type UserId = string
export type DeviceId = string
export type ProjectId = string
export type ProjectInstanceId = string
export type SetupRevisionId = string
export type JobId = string
export type OperationId = string
export type ApprovalId = string
export type ArtifactId = string
export type DiscoveryId = string
export type IsoTimestamp = string

export interface PortableSetupRevisionItem {
  artifactId: ArtifactId
  artifactKind: DiscoveryKind
  portableSource: string | null
  contentDigest: string
  toolId: string
  targetName: string
}

export interface PortableSetupRevision {
  setupId: string
  setupRevisionId: SetupRevisionId
  revisionNumber: number
  items: PortableSetupRevisionItem[]
}

export interface RunnerCapabilities {
  scanProject: boolean
  planSetup: boolean
  applyPlan: boolean
  rollbackOperation: boolean
  supportedTools: string[]
}

export interface CapabilityEnvelope {
  protocolVersion: ProtocolVersion
  supportedProtocolVersions: ProtocolVersion[]
  runnerVersion: string
  deviceId: DeviceId
  capabilities: RunnerCapabilities
}

export interface ScanProjectJob {
  kind: 'scanProject'
  payload: {
    projectId: ProjectId
    includeUnmanaged: boolean
  }
}

export interface PlanSetupJob {
  kind: 'planSetup'
  payload: {
    projectId: ProjectId
    revision: PortableSetupRevision
  }
}

export interface PlanApproval {
  approvalId: ApprovalId
  organizationId: OrganizationId
  projectInstanceId: ProjectInstanceId
  setupRevisionId: SetupRevisionId
  planDigest: string
  approvedBy: UserId
  approvedAt: IsoTimestamp
  expiresAt: IsoTimestamp
}

export interface ApplyPlanJob {
  kind: 'applyPlan'
  payload: {
    projectId: ProjectId
    revision: PortableSetupRevision
    approval: PlanApproval
  }
}

export interface RollbackOperationJob {
  kind: 'rollbackOperation'
  payload: {
    projectId: ProjectId
    operationId: OperationId
  }
}

export type RunnerJob =
  | ScanProjectJob
  | PlanSetupJob
  | ApplyPlanJob
  | RollbackOperationJob

export interface JobEnvelope {
  protocolVersion: ProtocolVersion
  jobId: JobId
  idempotencyKey: string
  organizationId: OrganizationId
  deviceId: DeviceId
  projectInstanceId: ProjectInstanceId
  issuedAt: IsoTimestamp
  expiresAt: IsoTimestamp
  job: RunnerJob
}

export type DiscoveryKind = 'skill' | 'pluginSkill' | 'localContent'
export type DiscoveryState = 'available' | 'conflict' | 'unsupported'

export interface ScanDiscovery {
  discoveryId: DiscoveryId
  kind: DiscoveryKind
  state: DiscoveryState
  name: string
  toolId: string
  portableSource: string | null
  contentDigest: string
}

export interface ScanResult {
  kind: 'scanResult'
  payload: {
    projectId: ProjectId
    discoveries: ScanDiscovery[]
  }
}

export type PlanActionKind = 'link' | 'copy' | 'removeManaged'
export type PlanChangeKind = 'add' | 'replace' | 'remove' | 'unchanged'

export interface PlanDestination {
  toolId: string
  projectRelativePath: string
}

export interface PlanAction {
  actionId: string
  kind: PlanActionKind
  change?: PlanChangeKind
  artifactId: ArtifactId
  destination: PlanDestination
}

export interface CanonicalPlan {
  setupRevisionId: SetupRevisionId
  planDigest: string
  actions: PlanAction[]
  conflicts: string[]
}

export interface PlanResult {
  kind: 'planResult'
  payload: {
    projectId: ProjectId
    plan: CanonicalPlan
  }
}

export type OperationOutcome = 'applied' | 'rolledBack' | 'noChange'
export type CancellationOutcome = 'cancelledAndRestored' | 'needsAttention'
export type Recoverability = 'notNeeded' | 'rollbackAvailable' | 'manualIntervention'

export interface ApplyReceipt {
  kind: 'applyReceipt'
  payload: {
    projectId: ProjectId
    operationId: OperationId
    setupRevisionId: SetupRevisionId
    planDigest: string
    outcome: OperationOutcome
    recoverability: Recoverability
    actionsApplied: number
    completedAt: IsoTimestamp
  }
}

export interface RollbackReceipt {
  kind: 'rollbackReceipt'
  payload: {
    projectId: ProjectId
    operationId: OperationId
    restoredSetupRevisionId: SetupRevisionId | null
    outcome: OperationOutcome
    recoverability: Recoverability
    completedAt: IsoTimestamp
  }
}

export interface CancellationReceipt {
  kind: 'cancellationReceipt'
  payload: {
    projectId: ProjectId
    operationId: OperationId | null
    outcome: CancellationOutcome
    recoverability: Recoverability
    actionsApplied: number
    completedAt: IsoTimestamp
  }
}

export type ProtocolErrorCode =
  | 'unsupportedProtocolVersion'
  | 'expiredJob'
  | 'invalidOrganization'
  | 'invalidDevice'
  | 'unknownProjectInstance'
  | 'capabilityUnavailable'
  | 'planDigestMismatch'
  | 'approvalExpired'
  | 'conflict'
  | 'operationFailed'
  | 'jobCancelled'
  | 'idempotencyMismatch'

export interface ErrorResult {
  kind: 'error'
  payload: {
    code: ProtocolErrorCode
    message: string
    retryable: boolean
    recoverability: Recoverability
  }
}

export type RunnerResult =
  | ScanResult
  | PlanResult
  | ApplyReceipt
  | RollbackReceipt
  | CancellationReceipt
  | ErrorResult

export interface ResultEnvelope {
  protocolVersion: ProtocolVersion
  jobId: JobId
  idempotencyKey: string
  organizationId: OrganizationId
  deviceId: DeviceId
  projectInstanceId: ProjectInstanceId
  result: RunnerResult
}

export class UnsupportedProtocolVersionError extends Error {
  readonly version: string

  constructor(version: string) {
    super(`Unsupported protocol version: ${version}`)
    this.name = 'UnsupportedProtocolVersionError'
    this.version = version
  }
}

export function assertSupportedProtocolVersion(
  version: string,
): asserts version is ProtocolVersion {
  if (version !== PROTOCOL_VERSION) {
    throw new UnsupportedProtocolVersionError(version)
  }
}

export function negotiateProtocolVersion(
  remoteVersions: readonly string[],
): ProtocolVersion | null {
  return remoteVersions.includes(PROTOCOL_VERSION) ? PROTOCOL_VERSION : null
}
