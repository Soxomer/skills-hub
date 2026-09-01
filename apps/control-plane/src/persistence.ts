import type {
  ApprovalId,
  ArtifactId,
  DeviceId,
  DiscoveryKind,
  JobEnvelope,
  JobId,
  OperationId,
  OrganizationId,
  PlanApproval,
  ProjectId,
  ProjectInstanceId,
  ResultEnvelope,
  SetupRevisionId,
  UserId,
} from '@ahm/contracts'

export interface OrganizationRecord {
  id: OrganizationId
  name: string
  createdAt: string
}

export interface ProjectRecord {
  id: ProjectId
  organizationId: OrganizationId
  name: string
  repositoryIdentity: string | null
  createdAt: string
  updatedAt: string
}

export interface SetupRevisionRecord {
  id: SetupRevisionId
  organizationId: OrganizationId
  setupId: string
  revisionNumber: number
  sourceScanJobId: JobId | null
  items: readonly PortableSetupRevisionItem[]
  createdBy: UserId
  createdAt: string
}

export interface PortableSetupRevisionItem {
  artifactId: ArtifactId
  artifactKind: DiscoveryKind
  portableSource: string | null
  contentDigest: string
  toolId: string
  targetName: string
}

export interface ProjectAssignmentRecord {
  organizationId: OrganizationId
  projectId: ProjectId
  setupRevisionId: SetupRevisionId
  assignedBy: UserId
  assignedAt: string
}

export interface RunnerDeviceRecord {
  id: DeviceId
  organizationId: OrganizationId
  label: string
  status: 'active' | 'revoked'
  enrolledAt: string
  lastSeenAt: string | null
}

export interface ProjectInstanceRecord {
  id: ProjectInstanceId
  organizationId: OrganizationId
  projectId: ProjectId
  deviceId: DeviceId
  registeredAt: string
  lastSeenAt: string | null
}

export interface StoredJob {
  id: JobId
  envelope: JobEnvelope
  state: 'pending' | 'leased' | 'succeeded' | 'failed' | 'expired' | 'cancelled'
}

export interface StoredApproval {
  id: ApprovalId
  projectInstanceId: ProjectInstanceId
  setupRevisionId: SetupRevisionId
  approval: PlanApproval
  consumedByJobId: JobId | null
}

export interface StoredReceipt {
  operationId: OperationId
  jobId: JobId
  result: ResultEnvelope
}

export interface ControlPlaneRepository {
  createOrganization(record: OrganizationRecord): Promise<void>
  createProject(record: ProjectRecord): Promise<void>
  appendSetupRevision(record: SetupRevisionRecord): Promise<void>
  assignProject(record: ProjectAssignmentRecord): Promise<void>
  registerRunner(record: RunnerDeviceRecord): Promise<void>
  registerProjectInstance(record: ProjectInstanceRecord): Promise<void>
  enqueueJob(record: StoredJob): Promise<void>
  storeApproval(record: StoredApproval): Promise<void>
  storeReceipt(record: StoredReceipt): Promise<void>
}
