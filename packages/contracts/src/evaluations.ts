import type { PortableSetupRevision, RunnerResult } from './protocol.js'
import type { RunnerJobStatusResponse } from './transport.js'

/** Immutable requested conditions; observed runtime identity is recorded in the result. */
export interface EvaluationProfile {
  harness: 'codex'
  profileVersion: 1
  model: string
  reasoningEffort: 'low' | 'medium' | 'high'
  sandbox: 'read-only'
  contextMode: 'skillInstructions'
  timeoutSeconds: 120
}

export interface EvaluateSetupsPayload {
  baseline: PortableSetupRevision
  candidate: PortableSetupRevision
  suiteId: 'code-review-v1'
  profile: EvaluationProfile
  repetitions: 1
}

export interface EvaluationRevisionReference { setupId: string; setupRevisionId: string }

export interface CreateEvaluationRequest {
  idempotencyKey: string
  deviceId: string
  baseline: EvaluationRevisionReference
  candidate: EvaluationRevisionReference
  profile: EvaluationProfile
}

export interface EvaluationSummary {
  jobId: string
  deviceId: string
  createdAt: string
  definition: EvaluateSetupsPayload
  state: RunnerJobStatusResponse['state']
  cancelRequested: boolean
  result: RunnerResult | null
}

export interface EvaluationListResponse { evaluations: EvaluationSummary[] }

export interface EvaluationVariantResult {
  setupRevisionId: string
  status: 'completed' | 'failed' | 'timedOut' | 'cancelled' | 'interrupted'
  durationMs: number
  checks: { id: string; label: string; passed: boolean }[]
  summary: string
  error: string | null
}

export interface EvaluationResultPayload {
  suiteId: 'code-review-v1'
  profile: EvaluationProfile
  observed: { harnessVersion: string; model: string | null; contextMode: 'skillInstructions'; nativeSkillActivation: false; inheritedInstructionsDigest: string | null; ambientContextVerified: false }
  baseline: EvaluationVariantResult
  candidate: EvaluationVariantResult
  completedAt: string
}
