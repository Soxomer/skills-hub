import type {
  CreateRunnerEnrollmentResponse,
  RunnerEnrollmentStatus,
  RunnerStatusResponse,
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

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ControlPlaneApiError'
    this.status = status
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
    return this.send('/api/v1/runner-enrollments', { method: 'POST' })
  }

  runnerEnrollment(enrollmentId: string): Promise<RunnerEnrollmentStatus> {
    return this.send(`/api/v1/runner-enrollments/${encodeURIComponent(enrollmentId)}`)
  }

  runner(deviceId: string): Promise<RunnerStatusResponse> {
    return this.send(`/api/v1/runners/${encodeURIComponent(deviceId)}`)
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
    })
    if (!response.ok) {
      let message = `Control-plane request failed (${response.status})`
      const body = (await response.json().catch(() => null)) as { error?: unknown } | null
      if (typeof body?.error === 'string' && body.error.trim()) message = body.error
      throw new ControlPlaneApiError(response.status, message)
    }
    return (await response.json()) as T
  }
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
