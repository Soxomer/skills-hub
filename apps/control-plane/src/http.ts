import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'

import type {
  ApplyReviewedPlanRequest,
  CaptureDefaultRevisionRequest,
  CreateProjectRequest,
  CreateSetupRequest,
  PublishSetupRevisionRequest,
  RequestSetupPlanRequest,
  RollbackOperationRequest,
} from '@ahm/contracts'

import { ProjectServiceError, type ProjectService } from './projects.js'

import {
  RunnerTransportError,
  type RequestActor,
  type RunnerTransportService,
} from './runner-transport.js'
import { SwitchingError, type SwitchingService } from './switching.js'
import { SetupServiceError, type SetupService } from './setups.js'
import type { BrowserAuthenticator } from './cloudflare-auth.js'

function requiredHeader(request: FastifyRequest, name: string): string {
  const value = request.headers[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RunnerTransportError(401, `missing ${name} header`)
  }
  return value
}

function developmentActor(request: FastifyRequest): RequestActor {
  return {
    organizationId: requiredHeader(request, 'x-ahm-organization-id'),
    userId: requiredHeader(request, 'x-ahm-user-id'),
  }
}

function runnerCredential(request: FastifyRequest): string {
  const authorization = requiredHeader(request, 'authorization')
  if (!authorization.startsWith('Bearer ') || authorization.length === 7) {
    throw new RunnerTransportError(401, 'runner bearer credential is required')
  }
  return authorization.slice(7)
}

export function createControlPlaneApp(
  transport: RunnerTransportService,
  projects: ProjectService,
  switching?: SwitchingService,
  setups?: SetupService,
  authenticateBrowser?: BrowserAuthenticator,
): FastifyInstance {
  const app = Fastify({ logger: false })
  const actors = new WeakMap<FastifyRequest, RequestActor>()
  app.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions.url?.startsWith('/runner/')) reply.header('cache-control', 'private, no-store')
    if (!request.routeOptions.url?.startsWith('/api/')) return
    reply.header('cache-control', 'private, no-store')
    actors.set(request, authenticateBrowser ? await authenticateBrowser(request) : developmentActor(request))
  })
  const actor = (request: FastifyRequest): RequestActor => {
    const identity = actors.get(request)
    if (!identity) throw new RunnerTransportError(401, 'Sign in to continue')
    return identity
  }

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RunnerTransportError) {
      void reply.code(error.statusCode).send({ error: error.message })
      return
    }
    if (error instanceof ProjectServiceError) {
      void reply.code(error.statusCode).send({ code: error.code, error: error.message })
      return
    }
    if (error instanceof SwitchingError) {
      void reply.code(error.statusCode).send({
        code: error.code,
        error: error.message,
        ...error.details,
      })
      return
    }
    if (error instanceof SetupServiceError) {
      void reply.code(error.statusCode).send({ code: error.code, error: error.message })
      return
    }
    if (error instanceof Error && 'validation' in error && error.validation) {
      void reply.code(400).send({ error: error.message })
      return
    }
    void reply.code(500).send({ error: 'control-plane request failed' })
  })

  app.get('/health', async () => ({ status: 'ok' }))

  app.get('/api/v1/projects', async (request) => projects.listProjects(actor(request)))

  app.post<{ Body: CreateProjectRequest }>('/api/v1/projects', async (request, reply) => {
    const project = await projects.createProject(actor(request), request.body)
    return reply.code(201).send(project)
  })

  app.post<{
    Params: { projectId: string }
    Body: CaptureDefaultRevisionRequest
  }>('/api/v1/projects/:projectId/default-revisions', async (request, reply) => {
    const result = await projects.captureDefault(
      actor(request),
      request.params.projectId,
      request.body,
    )
    return reply.code(result.created ? 201 : 200).send(result)
  })

  if (setups) {
    app.get('/api/v1/setups', async (request) => setups.listSetups(actor(request)))
    app.get<{ Params: { setupId: string } }>('/api/v1/setups/:setupId', async (request) =>
      setups.setupDetail(actor(request), request.params.setupId),
    )
    app.post<{ Params: { setupId: string }; Body: PublishSetupRevisionRequest }>(
      '/api/v1/setups/:setupId/revisions', async (request, reply) => {
        const revision = await setups.publishRevision(actor(request), request.params.setupId, request.body)
        return reply.code(201).send(revision)
      },
    )
    app.get<{ Params: { setupId: string; revisionId: string; contentDigest: string } }>(
      '/api/v1/setups/:setupId/revisions/:revisionId/artifacts/:contentDigest', async (request) =>
        setups.revisionArtifact(actor(request), request.params.setupId, request.params.revisionId, request.params.contentDigest),
    )
    app.get('/api/v1/setups/composer', async (request) => setups.composer(actor(request)))

    app.post<{ Body: CreateSetupRequest }>('/api/v1/setups', async (request, reply) => {
      const revision = await setups.createSetup(actor(request), request.body)
      return reply.code(201).send(revision)
    })
  }

  if (switching) {
    app.get<{ Params: { projectId: string } }>(
      '/api/v1/projects/:projectId/setup-revisions',
      async (request) => switching.projectSetupState(actor(request), request.params.projectId),
    )

    app.get<{ Params: { projectInstanceId: string } }>(
      '/api/v1/project-instances/:projectInstanceId/operations',
      async (request) =>
        switching.projectInstanceOperations(actor(request), request.params.projectInstanceId),
    )

    app.post<{
      Params: { projectInstanceId: string }
      Body: RequestSetupPlanRequest
    }>('/api/v1/project-instances/:projectInstanceId/plan', async (request) =>
      switching.requestPlan(actor(request), request.params.projectInstanceId, request.body),
    )

    app.post<{
      Params: { projectInstanceId: string }
      Body: ApplyReviewedPlanRequest
    }>('/api/v1/project-instances/:projectInstanceId/apply', async (request) =>
      switching.applyReviewedPlan(actor(request), request.params.projectInstanceId, request.body),
    )

    app.post<{
      Params: { projectInstanceId: string }
      Body: RollbackOperationRequest
    }>('/api/v1/project-instances/:projectInstanceId/rollback', async (request) =>
      switching.requestRollback(actor(request), request.params.projectInstanceId, request.body),
    )
  }

  app.post('/api/v1/runner-enrollments', async (request) =>
    transport.createEnrollment(actor(request)),
  )

  app.get<{ Params: { enrollmentId: string } }>(
    '/api/v1/runner-enrollments/:enrollmentId',
    async (request) => transport.enrollmentStatus(actor(request), request.params.enrollmentId),
  )

  app.get<{ Params: { deviceId: string } }>('/api/v1/runners/:deviceId', async (request) =>
    transport.runnerStatus(actor(request), request.params.deviceId),
  )

  app.post<{
    Params: { projectInstanceId: string }
    Body: { includeUnmanaged?: boolean }
  }>('/api/v1/project-instances/:projectInstanceId/scan', async (request) =>
    transport.enqueueScan(
      actor(request),
      request.params.projectInstanceId,
      request.body?.includeUnmanaged ?? true,
    ),
  )

  app.get<{ Params: { jobId: string } }>('/api/v1/jobs/:jobId', async (request) =>
    transport.jobStatus(actor(request), request.params.jobId),
  )

  app.post<{ Params: { jobId: string } }>('/api/v1/jobs/:jobId/cancel', async (request, reply) => {
    await transport.cancelJob(actor(request), request.params.jobId)
    return reply.code(204).send()
  })

  app.post<{ Params: { deviceId: string } }>(
    '/api/v1/runners/:deviceId/revoke',
    async (request, reply) => {
      await transport.revokeRunner(actor(request), request.params.deviceId)
      return reply.code(204).send()
    },
  )

  app.post<{ Body: Parameters<RunnerTransportService['enroll']>[0] }>(
    '/runner/v1/enroll',
    async (request) => transport.enroll(request.body),
  )

  app.put<{
    Params: { projectInstanceId: string }
    Body: Omit<Parameters<RunnerTransportService['registerProjectInstance']>[1], 'projectInstanceId'>
  }>('/runner/v1/project-instances/:projectInstanceId', async (request, reply) => {
    await transport.registerProjectInstance(runnerCredential(request), {
      ...request.body,
      projectInstanceId: request.params.projectInstanceId,
    })
    return reply.code(204).send()
  })

  app.post<{ Body: Parameters<RunnerTransportService['claimJob']>[1] }>(
    '/runner/v1/jobs/claim',
    async (request, reply) => {
      const job = await transport.claimJob(runnerCredential(request), request.body)
      if (!job) return reply.header('retry-after', '2').code(204).send()
      return job
    },
  )

  app.put<{ Body: Parameters<RunnerTransportService['storeArtifact']>[1] }>(
    '/runner/v1/artifacts',
    { bodyLimit: 15 * 1024 * 1024 },
    async (request, reply) => {
      await transport.storeArtifact(runnerCredential(request), request.body)
      return reply.code(204).send()
    },
  )

  app.get<{ Params: { contentDigest: string } }>(
    '/runner/v1/artifacts/:contentDigest',
    async (request) =>
      transport.loadArtifact(runnerCredential(request), request.params.contentDigest),
  )

  app.post<{
    Params: { jobId: string }
    Body: Parameters<RunnerTransportService['acknowledgeJob']>[2]
  }>('/runner/v1/jobs/:jobId/ack', async (request) =>
    transport.acknowledgeJob(
      runnerCredential(request),
      request.params.jobId,
      request.body,
    ),
  )

  app.post<{
    Params: { jobId: string }
    Body: Parameters<RunnerTransportService['jobControl']>[2]
  }>('/runner/v1/jobs/:jobId/control', async (request) =>
    transport.jobControl(runnerCredential(request), request.params.jobId, request.body),
  )

  app.post<{
    Params: { jobId: string }
    Body: Parameters<RunnerTransportService['submitResult']>[2]
  }>('/runner/v1/jobs/:jobId/result', async (request) =>
    transport.submitResult(runnerCredential(request), request.params.jobId, request.body),
  )

  return app
}
