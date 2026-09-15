import type {
  ArtifactBundle,
  LibraryRequest,
  SetupLibraryResponse,
  SetupDetail,
  PublishSetupRevisionRequest,
  SetupRevisionSummary,
  ApplyReviewedPlanRequest,
  ApplyReviewedPlanResponse,
  CaptureDefaultRevisionRequest,
  CaptureDefaultRevisionResponse,
  CreateProjectRequest,
  CreateSetupRequest,
  CreatedSetupRevision,
  CreateRunnerEnrollmentResponse,
  ProjectListResponse,
  ProjectActiveOperation,
  ProjectInstanceOperationsResponse,
  ProjectSetupStateResponse,
  RequestSetupPlanRequest,
  RollbackOperationRequest,
  ProjectSummary,
  RunnerEnrollmentStatus,
  RunnerJobStatusResponse,
  RunnerStatusResponse,
  SetupComposerResponse,
} from '@ahm/contracts'

export interface RequestActor {
  organizationId: string
  userId: string
}

export interface ControlPlaneClientOptions {
  baseUrl: string
  actor: RequestActor
  fetch?: typeof fetch
}

export class ControlPlaneApiError extends Error {
  readonly status: number
  readonly code: string | null
  readonly activeOperation: ProjectActiveOperation | null

  constructor(
    status: number,
    message: string,
    code: string | null = null,
    activeOperation: ProjectActiveOperation | null = null,
  ) {
    super(message)
    this.name = 'ControlPlaneApiError'
    this.status = status
    this.code = code
    this.activeOperation = activeOperation
  }
}

export class ControlPlaneClient {
  private readonly baseUrl: string
  private readonly request: typeof fetch
  private readonly options: ControlPlaneClientOptions

  constructor(options: ControlPlaneClientOptions) {
    this.options = options
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.request = options.fetch ?? ((input, init) => fetch(input, init))
  }

  createRunnerEnrollment(): Promise<CreateRunnerEnrollmentResponse> {
    return this.send('/api/v1/runner-enrollments', this.jsonRequest('POST', {}))
  }

  runnerEnrollment(enrollmentId: string): Promise<RunnerEnrollmentStatus> {
    return this.send(`/api/v1/runner-enrollments/${encodeURIComponent(enrollmentId)}`)
  }

  runner(deviceId: string): Promise<RunnerStatusResponse> {
    return this.send(`/api/v1/runners/${encodeURIComponent(deviceId)}`)
  }

  catalogue(request: LibraryRequest): Promise<unknown> {
    return this.send('/api/v1/library/catalogue', this.jsonRequest('POST', request))
  }

  library(deviceId: string, request: LibraryRequest): Promise<{ jobId: string }> {
    return this.send('/api/v1/runners/' + encodeURIComponent(deviceId) + '/library', this.jsonRequest('POST', request))
  }

  projects(): Promise<ProjectListResponse> {
    return this.send('/api/v1/projects')
  }

  createProject(request: CreateProjectRequest): Promise<ProjectSummary> {
    return this.send('/api/v1/projects', this.jsonRequest('POST', request))
  }

  scanProject(projectInstanceId: string): Promise<{ jobId: string }> {
    return this.send(
      `/api/v1/project-instances/${encodeURIComponent(projectInstanceId)}/scan`,
      this.jsonRequest('POST', { includeUnmanaged: true }),
    )
  }

  job(jobId: string): Promise<RunnerJobStatusResponse> {
    return this.send(`/api/v1/jobs/${encodeURIComponent(jobId)}`)
  }

  cancelJob(jobId: string): Promise<void> {
    return this.send(
      `/api/v1/jobs/${encodeURIComponent(jobId)}/cancel`,
      this.jsonRequest('POST', {}),
    )
  }

  captureDefault(
    projectId: string,
    request: CaptureDefaultRevisionRequest,
  ): Promise<CaptureDefaultRevisionResponse> {
    return this.send(
      `/api/v1/projects/${encodeURIComponent(projectId)}/default-revisions`,
      this.jsonRequest('POST', request),
    )
  }

  setupComposer(): Promise<SetupComposerResponse> {
    return this.send('/api/v1/setups/composer')
  }

  setups(): Promise<SetupLibraryResponse> {
    return this.send('/api/v1/setups')
  }

  setup(setupId: string): Promise<SetupDetail> {
    return this.send(`/api/v1/setups/${encodeURIComponent(setupId)}`)
  }

  publishSetupRevision(setupId: string, request: PublishSetupRevisionRequest): Promise<SetupRevisionSummary> {
    return this.send(`/api/v1/setups/${encodeURIComponent(setupId)}/revisions`, this.jsonRequest('POST', request))
  }

  setupArtifact(setupId: string, revisionId: string, digest: string): Promise<ArtifactBundle> {
    return this.send(`/api/v1/setups/${encodeURIComponent(setupId)}/revisions/${encodeURIComponent(revisionId)}/artifacts/${encodeURIComponent(digest)}`)
  }

  createSetup(request: CreateSetupRequest): Promise<CreatedSetupRevision> {
    return this.send('/api/v1/setups', this.jsonRequest('POST', request))
  }

  setupRevisions(projectId: string): Promise<ProjectSetupStateResponse> {
    return this.send(`/api/v1/projects/${encodeURIComponent(projectId)}/setup-revisions`)
  }

  projectOperations(projectInstanceId: string): Promise<ProjectInstanceOperationsResponse> {
    return this.send(
      `/api/v1/project-instances/${encodeURIComponent(projectInstanceId)}/operations`,
    )
  }

  prepareSetupPlan(
    projectInstanceId: string,
    request: RequestSetupPlanRequest,
  ): Promise<{ jobId: string }> {
    return this.send(
      `/api/v1/project-instances/${encodeURIComponent(projectInstanceId)}/plan`,
      this.jsonRequest('POST', request),
    )
  }

  applySetupPlan(
    projectInstanceId: string,
    request: ApplyReviewedPlanRequest,
  ): Promise<ApplyReviewedPlanResponse> {
    return this.send(
      `/api/v1/project-instances/${encodeURIComponent(projectInstanceId)}/apply`,
      this.jsonRequest('POST', request),
    )
  }

  rollbackSetup(
    projectInstanceId: string,
    request: RollbackOperationRequest,
  ): Promise<{ jobId: string }> {
    return this.send(
      `/api/v1/project-instances/${encodeURIComponent(projectInstanceId)}/rollback`,
      this.jsonRequest('POST', request),
    )
  }

  private jsonRequest(method: string, body: unknown): RequestInit {
    return {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }
  }

  private async send<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        'x-ahm-organization-id': this.options.actor.organizationId,
        'x-ahm-user-id': this.options.actor.userId,
        ...init.headers,
      },
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
    })
    if (!response.ok) {
      let message = `Control-plane request failed (${response.status})`
      const body = (await response.json().catch(() => null)) as {
        code?: unknown
        error?: unknown
        activeOperation?: unknown
      } | null
      if (typeof body?.error === 'string' && body.error.trim()) message = body.error
      throw new ControlPlaneApiError(
        response.status,
        message,
        typeof body?.code === 'string' ? body.code : null,
        isProjectActiveOperation(body?.activeOperation) ? body.activeOperation : null,
      )
    }
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }
}

function isProjectActiveOperation(value: unknown): value is ProjectActiveOperation {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ProjectActiveOperation>
  return (
    typeof candidate.jobId === 'string' &&
    ['planSetup', 'applyPlan', 'rollbackOperation'].includes(candidate.kind ?? '') &&
    ['pending', 'leased', 'acknowledged'].includes(candidate.state ?? '')
  )
}

export function createBrowserClient(): ControlPlaneClient {
  return new ControlPlaneClient({
    baseUrl: import.meta.env.VITE_AHM_API_BASE_URL ?? '',
    actor: {
      organizationId: import.meta.env.VITE_AHM_ORGANIZATION_ID ?? 'org_local',
      userId: import.meta.env.VITE_AHM_USER_ID ?? 'user_local',
    },
  })
}
