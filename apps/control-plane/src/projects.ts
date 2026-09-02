import { randomUUID } from 'node:crypto'

import type {
  CaptureDefaultRevisionRequest,
  CaptureDefaultRevisionResponse,
  CreateProjectRequest,
  DefaultRevisionSummary,
  DiscoveryKind,
  ProjectListResponse,
  ProjectSummary,
  ResultEnvelope,
} from '@ahm/contracts'

import type { RequestActor } from './runner-transport.js'

export interface StoredProject extends ProjectSummary {
  organizationId: string
}

export interface ScanJobRecord {
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
}

export interface DefaultCaptureItem {
  discoveryId: string
  kind: DiscoveryKind
  name: string
  toolId: string
  portableSource: string | null
  contentDigest: string
}

export interface CaptureDefaultRecord {
  organizationId: string
  projectId: string
  scanJobId: string
  createdBy: string
  createdAt: string
  setupId: string
  setupRevisionId: string
  auditEventId: string
  items: readonly DefaultCaptureItem[]
}

export interface StoredDefaultCapture {
  revision: DefaultRevisionSummary
  items: DefaultCaptureItem[]
}

export type CaptureDefaultOutcome =
  | { outcome: 'created' | 'existing'; capture: StoredDefaultCapture }
  | { outcome: 'projectMissing' }

export interface ProjectRepository {
  createProject(project: StoredProject): Promise<boolean>
  listProjects(organizationId: string): Promise<StoredProject[]>
  scanJob(
    organizationId: string,
    projectId: string,
    jobId: string,
  ): Promise<ScanJobRecord | null>
  captureDefault(record: CaptureDefaultRecord): Promise<CaptureDefaultOutcome>
}

export type ProjectServiceErrorCode =
  | 'invalidProjectName'
  | 'invalidRepositoryIdentity'
  | 'projectNameTaken'
  | 'invalidCaptureRequest'
  | 'scanNotFound'
  | 'scanNotReady'
  | 'scanUnavailable'
  | 'invalidScanResult'
  | 'discoveryNotEligible'
  | 'projectNotFound'
  | 'defaultAlreadyCaptured'

export class ProjectServiceError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ProjectServiceErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ProjectServiceError'
  }
}

export interface ProjectServiceOptions {
  now?: () => Date
  randomId?: () => string
}

function sameSelection(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const sortedLeft = [...left].sort()
  const sortedRight = [...right].sort()
  return sortedLeft.every((value, index) => value === sortedRight[index])
}

function publicProject(project: StoredProject): ProjectSummary {
  return {
    projectId: project.projectId,
    name: project.name,
    repositoryIdentity: project.repositoryIdentity,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    defaultRevision: project.defaultRevision,
  }
}

export class ProjectService {
  private readonly now: () => Date
  private readonly randomId: () => string

  constructor(
    private readonly repository: ProjectRepository,
    options: ProjectServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.randomId = options.randomId ?? randomUUID
  }

  async listProjects(actor: RequestActor): Promise<ProjectListResponse> {
    const projects = await this.repository.listProjects(actor.organizationId)
    return { projects: projects.map(publicProject) }
  }

  async createProject(actor: RequestActor, request: CreateProjectRequest): Promise<ProjectSummary> {
    if (typeof request?.name !== 'string') {
      throw new ProjectServiceError(400, 'invalidProjectName', 'project name is required')
    }
    const name = request.name.trim()
    if (name.length < 1 || name.length > 120) {
      throw new ProjectServiceError(
        400,
        'invalidProjectName',
        'project name must contain between 1 and 120 characters',
      )
    }
    let repositoryIdentity: string | null = null
    if (request.repositoryIdentity !== undefined && request.repositoryIdentity !== null) {
      if (typeof request.repositoryIdentity !== 'string') {
        throw new ProjectServiceError(
          400,
          'invalidRepositoryIdentity',
          'repository identity must be text',
        )
      }
      repositoryIdentity = request.repositoryIdentity.trim() || null
      if (repositoryIdentity && repositoryIdentity.length > 500) {
        throw new ProjectServiceError(
          400,
          'invalidRepositoryIdentity',
          'repository identity must contain at most 500 characters',
        )
      }
    }
    const now = this.now().toISOString()
    const project: StoredProject = {
      organizationId: actor.organizationId,
      projectId: `project_${this.randomId()}`,
      name,
      repositoryIdentity,
      createdAt: now,
      updatedAt: now,
      defaultRevision: null,
    }
    if (!(await this.repository.createProject(project))) {
      throw new ProjectServiceError(
        409,
        'projectNameTaken',
        'a project with this name already exists',
      )
    }
    return publicProject(project)
  }

  async captureDefault(
    actor: RequestActor,
    projectId: string,
    request: CaptureDefaultRevisionRequest,
  ): Promise<CaptureDefaultRevisionResponse> {
    if (
      typeof request?.scanJobId !== 'string' ||
      request.scanJobId.trim() === '' ||
      !Array.isArray(request.includedDiscoveryIds) ||
      request.includedDiscoveryIds.length > 5_000 ||
      request.includedDiscoveryIds.some(
        (discoveryId) => typeof discoveryId !== 'string' || discoveryId.trim() === '',
      )
    ) {
      throw new ProjectServiceError(
        400,
        'invalidCaptureRequest',
        'scan job and included discovery IDs are required',
      )
    }
    const includedDiscoveryIds = request.includedDiscoveryIds.map((id) => id.trim())
    const scanJobId = request.scanJobId.trim()
    if (new Set(includedDiscoveryIds).size !== includedDiscoveryIds.length) {
      throw new ProjectServiceError(
        400,
        'invalidCaptureRequest',
        'included discovery IDs must be unique',
      )
    }
    const scan = await this.repository.scanJob(
      actor.organizationId,
      projectId,
      scanJobId,
    )
    if (!scan) {
      throw new ProjectServiceError(404, 'scanNotFound', 'project scan was not found')
    }
    if (
      scan.state === 'pending' ||
      scan.state === 'leased' ||
      scan.state === 'acknowledged'
    ) {
      throw new ProjectServiceError(409, 'scanNotReady', 'project scan is still running')
    }
    if (scan.state !== 'succeeded') {
      throw new ProjectServiceError(409, 'scanUnavailable', 'project scan did not succeed')
    }
    if (
      !scan.result ||
      scan.result.result.kind !== 'scanResult' ||
      scan.result.result.payload.projectId !== projectId
    ) {
      throw new ProjectServiceError(
        409,
        'invalidScanResult',
        'runner result does not match this project scan',
      )
    }
    const discoveries = new Map(
      scan.result.result.payload.discoveries.map((discovery) => [discovery.discoveryId, discovery]),
    )
    if (discoveries.size !== scan.result.result.payload.discoveries.length) {
      throw new ProjectServiceError(
        409,
        'invalidScanResult',
        'runner result contains duplicate discoveries',
      )
    }
    const items = includedDiscoveryIds.map((discoveryId) => {
      const discovery = discoveries.get(discoveryId)
      if (!discovery || discovery.state !== 'available') {
        throw new ProjectServiceError(
          409,
          'discoveryNotEligible',
          'only available scan discoveries can be captured',
        )
      }
      return {
        discoveryId: discovery.discoveryId,
        kind: discovery.kind,
        name: discovery.name,
        toolId: discovery.toolId,
        portableSource: discovery.portableSource,
        contentDigest: discovery.contentDigest,
      }
    })
    const suffix = this.randomId()
    const outcome = await this.repository.captureDefault({
      organizationId: actor.organizationId,
      projectId,
      scanJobId: scan.jobId,
      createdBy: actor.userId,
      createdAt: this.now().toISOString(),
      setupId: `setup_${suffix}`,
      setupRevisionId: `revision_${suffix}`,
      auditEventId: `audit_${suffix}`,
      items,
    })
    if (outcome.outcome === 'projectMissing') {
      throw new ProjectServiceError(404, 'projectNotFound', 'logical project was not found')
    }
    if (
      outcome.outcome === 'existing' &&
      (outcome.capture.revision.sourceScanJobId !== scan.jobId ||
        !sameSelection(
          outcome.capture.items.map((item) => item.discoveryId),
          includedDiscoveryIds,
        ))
    ) {
      throw new ProjectServiceError(
        409,
        'defaultAlreadyCaptured',
        'this project already has a different Default revision',
      )
    }
    return {
      projectId,
      created: outcome.outcome === 'created',
      defaultRevision: outcome.capture.revision,
    }
  }
}
