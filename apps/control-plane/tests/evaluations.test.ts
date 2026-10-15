import { describe, expect, it, vi } from 'vitest'
import type { CreateEvaluationRequest, EvaluateSetupsPayload, EvaluationResultPayload } from '@ahm/contracts'
import { EvaluationService, type EvaluationRepository } from '../src/evaluations.js'
import { evaluationResultMatches, sameEvaluationProfile } from '../src/evaluation-results.js'

const actor = { organizationId: 'org', userId: 'owner' }
const request: CreateEvaluationRequest = {
  idempotencyKey: 'once', deviceId: 'device', baseline: { setupId: 'setup', setupRevisionId: 'v1' }, candidate: { setupId: 'setup', setupRevisionId: 'v2' },
  profile: { harness: 'codex', profileVersion: 1, model: 'model-test', reasoningEffort: 'medium', sandbox: 'read-only', contextMode: 'skillInstructions', timeoutSeconds: 120 },
}
const definition: EvaluateSetupsPayload = { baseline: { ...request.baseline, revisionNumber: 1, items: [] }, candidate: { ...request.candidate, revisionNumber: 2, items: [] }, profile: request.profile, suiteId: 'code-review-v1', repetitions: 1 }
const variant = { setupRevisionId: 'v1', status: 'completed' as const, durationMs: 1234, checks: ['discount', 'clamp', 'contains'].map(id => ({ id, label: id, passed: true })), summary: 'Deterministic task checks', error: null }
const result: EvaluationResultPayload = { suiteId: 'code-review-v1', profile: request.profile, observed: { harnessVersion: 'codex-test', model: null, contextMode: 'skillInstructions', nativeSkillActivation: false, inheritedInstructionsDigest: null, ambientContextVerified: false }, baseline: variant, candidate: { ...variant, setupRevisionId: 'v2' }, completedAt: '2026-10-15T12:00:00Z' }

describe('evaluation service request boundary', () => {
  it('accepts only declarative exact revisions and forwards authenticated actor', async () => {
    const repository = { create: vi.fn().mockResolvedValue({ jobId: 'job' }), list: vi.fn().mockResolvedValue([]) } satisfies EvaluationRepository
    const service = new EvaluationService(repository)
    await expect(service.create(actor, request)).resolves.toEqual({ jobId: 'job' })
    expect(repository.create).toHaveBeenCalledWith(actor, request, expect.stringMatching(/^evaluation_/), expect.any(String))
    expect(await service.list(actor, 'v2')).toEqual({ evaluations: [] })
    expect(repository.list).toHaveBeenCalledWith(actor, 'v2')
  })

  it.each([
    { ...request, command: 'run anything' },
    { ...request, baseline: request.candidate },
    { ...request, candidate: { setupId: 'setup', setupRevisionId: '../private' } },
    { ...request, profile: { ...request.profile, harness: 'arbitrary' } },
    { ...request, profile: { ...request.profile, model: '--dangerous' } },
    { ...request, profile: { ...request.profile, sandbox: 'danger-full-access' } },
    { ...request, profile: { ...request.profile, timeoutSeconds: 3600 } },
    { ...request, profile: { ...request.profile, command: 'bad' } },
  ])('rejects unsupported or caller-expanded evaluation definition %#', async input => {
    const repository = { create: vi.fn(), list: vi.fn() }
    await expect(new EvaluationService(repository).create(actor, input as CreateEvaluationRequest)).rejects.toMatchObject({ statusCode: 400 })
    expect(repository.create).not.toHaveBeenCalled()
  })
})

describe('evaluation result binding', () => {
  it('accepts exact matching evidence regardless of JSONB property order', () => {
    expect(evaluationResultMatches(definition, result)).toBe(true)
    expect(sameEvaluationProfile(request.profile, Object.fromEntries(Object.entries(request.profile).reverse()) as typeof request.profile)).toBe(true)
  })
  it.each([
    { ...result, transcript: 'unexpected private trace' },
    { ...result, profile: { ...result.profile, model: 'different' } },
    { ...result, baseline: { ...variant, setupRevisionId: 'v2' } },
    { ...result, observed: { ...result.observed, nativeSkillActivation: true } },
    { ...result, baseline: { ...variant, checks: [] } },
    { ...result, baseline: { ...variant, checks: [variant.checks[0], variant.checks[0], variant.checks[0]] } },
    { ...result, baseline: { ...variant, durationMs: -1 } },
    { ...result, baseline: { ...variant, summary: 'x'.repeat(2001) } },
  ])('rejects evidence from mismatched conditions or malformed graders %#', input => {
    expect(evaluationResultMatches(definition, input as EvaluationResultPayload)).toBe(false)
  })
  it('preserves interrupted execution separately from task failures', () => {
    expect(evaluationResultMatches(definition, { ...result, baseline: { ...variant, status: 'interrupted', checks: [], error: 'Execution interrupted' } })).toBe(true)
    expect(evaluationResultMatches(definition, { ...result, baseline: { ...variant, checks: variant.checks.map(check => ({ ...check, passed: false })) } })).toBe(true)
  })
})
