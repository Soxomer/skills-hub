import type {
  DiscoveryId,
  IsoTimestamp,
  JobId,
  ProjectId,
  SetupRevisionId,
} from './protocol.js'

export interface DefaultRevisionSummary {
  setupId: string
  setupRevisionId: SetupRevisionId
  revisionNumber: number
  sourceScanJobId: JobId | null
  itemCount: number
  createdAt: IsoTimestamp
}

export interface ProjectSummary {
  projectId: ProjectId
  name: string
  repositoryIdentity: string | null
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
  defaultRevision: DefaultRevisionSummary | null
}

export interface ProjectListResponse {
  projects: ProjectSummary[]
}

export interface CreateProjectRequest {
  name: string
  repositoryIdentity?: string | null
}

export interface CaptureDefaultRevisionRequest {
  scanJobId: JobId
  includedDiscoveryIds: DiscoveryId[]
}

export interface CaptureDefaultRevisionResponse {
  projectId: ProjectId
  created: boolean
  defaultRevision: DefaultRevisionSummary
}
