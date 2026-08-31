import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'

import {
  RunnerTransportError,
  type RequestActor,
  type RunnerTransportService,
} from './runner-transport.js'

function requiredHeader(request: FastifyRequest, name: string): string {
  const value = request.headers[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RunnerTransportError(401, `missing ${name} header`)
  }
  return value
}

function actor(request: FastifyRequest): RequestActor {
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

export function createControlPlaneApp(service: RunnerTransportService): FastifyInstance {
  const app = Fastify({ logger: false })

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RunnerTransportError) {
      void reply.code(error.statusCode).send({ error: error.message })
      return
    }
    if (error instanceof Error && 'validation' in error && error.validation) {
      void reply.code(400).send({ error: error.message })
      return
    }
    void reply.code(500).send({ error: 'control-plane request failed' })
  })

  app.get('/health', async () => ({ status: 'ok' }))

  app.post('/api/v1/runner-enrollments', async (request) =>
    service.createEnrollment(actor(request)),
  )

  app.get<{ Params: { enrollmentId: string } }>(
    '/api/v1/runner-enrollments/:enrollmentId',
    async (request) => service.enrollmentStatus(actor(request), request.params.enrollmentId),
  )

  app.post<{
    Params: { projectInstanceId: string }
    Body: { includeUnmanaged?: boolean }
  }>('/api/v1/project-instances/:projectInstanceId/scan', async (request) =>
    service.enqueueScan(
      actor(request),
      request.params.projectInstanceId,
      request.body?.includeUnmanaged ?? true,
    ),
  )

  app.get<{ Params: { jobId: string } }>('/api/v1/jobs/:jobId', async (request) =>
    service.jobStatus(actor(request), request.params.jobId),
  )

  app.post<{ Params: { jobId: string } }>('/api/v1/jobs/:jobId/cancel', async (request, reply) => {
    await service.cancelJob(actor(request), request.params.jobId)
    return reply.code(204).send()
  })

  app.post<{ Params: { deviceId: string } }>(
    '/api/v1/runners/:deviceId/revoke',
    async (request, reply) => {
      await service.revokeRunner(actor(request), request.params.deviceId)
      return reply.code(204).send()
    },
  )

  app.post<{ Body: Parameters<RunnerTransportService['enroll']>[0] }>(
    '/runner/v1/enroll',
    async (request) => service.enroll(request.body),
  )

  app.put<{
    Params: { projectInstanceId: string }
    Body: Omit<Parameters<RunnerTransportService['registerProjectInstance']>[1], 'projectInstanceId'>
  }>('/runner/v1/project-instances/:projectInstanceId', async (request, reply) => {
    await service.registerProjectInstance(runnerCredential(request), {
      ...request.body,
      projectInstanceId: request.params.projectInstanceId,
    })
    return reply.code(204).send()
  })

  app.post<{ Body: Parameters<RunnerTransportService['claimJob']>[1] }>(
    '/runner/v1/jobs/claim',
    async (request, reply) => {
      const job = await service.claimJob(runnerCredential(request), request.body)
      if (!job) return reply.header('retry-after', '2').code(204).send()
      return job
    },
  )

  app.post<{
    Params: { jobId: string }
    Body: Parameters<RunnerTransportService['submitResult']>[2]
  }>('/runner/v1/jobs/:jobId/result', async (request) =>
    service.submitResult(runnerCredential(request), request.params.jobId, request.body),
  )

  return app
}
