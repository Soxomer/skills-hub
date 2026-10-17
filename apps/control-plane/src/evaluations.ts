import { randomUUID } from 'node:crypto'
import type { CreateEvaluationRequest, EvaluationListResponse, EvaluationProfile, EvaluationSummary } from '@ahm/contracts'
import { RunnerTransportError, type RequestActor } from './runner-transport.js'

export interface EvaluationRepository {
  create(actor: RequestActor, request: CreateEvaluationRequest, jobId: string, now: string): Promise<EvaluationSummary>
  list(actor: RequestActor, candidateRevisionId: string): Promise<EvaluationSummary[]>
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,200}$/.test(value)
}

export function isEvaluationProfile(value: unknown): value is EvaluationProfile {
  if (!value || typeof value !== 'object') return false
  const profile = value as Record<string, unknown>
  return Object.keys(profile).length === 7 && profile.harness === 'codex' && profile.profileVersion === 1 &&
    typeof profile.model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(profile.model) &&
    ['low', 'medium', 'high'].includes(String(profile.reasoningEffort)) && profile.sandbox === 'read-only' &&
    profile.contextMode === 'skillInstructions' && profile.timeoutSeconds === 120
}

export class EvaluationService {
  constructor(private readonly repository: EvaluationRepository) {}

  async create(actor: RequestActor, request: CreateEvaluationRequest): Promise<EvaluationSummary> {
    if (!request || Object.keys(request).length !== 5 || !identifier(request.idempotencyKey) || !identifier(request.deviceId) ||
      !request.baseline || !request.candidate || Object.keys(request.baseline).length !== 2 || Object.keys(request.candidate).length !== 2 ||
      !identifier(request.baseline.setupId) || !identifier(request.baseline.setupRevisionId) ||
      !identifier(request.candidate.setupId) || !identifier(request.candidate.setupRevisionId) || !isEvaluationProfile(request.profile)) {
      throw new RunnerTransportError(400, 'Select two exact Setup versions and a supported Codex evaluation profile', 'evaluationInvalidRequest')
    }
    if (request.baseline.setupRevisionId === request.candidate.setupRevisionId) {
      throw new RunnerTransportError(400, 'Choose a different baseline Setup version', 'evaluationInvalidRequest')
    }
    return this.repository.create(actor, request, `evaluation_${randomUUID()}`, new Date().toISOString())
  }

  async list(actor: RequestActor, candidateRevisionId: string): Promise<EvaluationListResponse> {
    if (!identifier(candidateRevisionId)) throw new RunnerTransportError(400, 'An exact candidate Setup revision is required')
    return { evaluations: await this.repository.list(actor, candidateRevisionId) }
  }
}
