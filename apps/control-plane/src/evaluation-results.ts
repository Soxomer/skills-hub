import type { EvaluateSetupsPayload, EvaluationProfile, EvaluationResultPayload } from '@ahm/contracts'

function exactKeys(value: unknown, fields: string[]): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)) &&
    Object.keys(value as object).length === fields.length && fields.every((field) => Object.hasOwn(value as object, field))
}

export function sameEvaluationProfile(left: EvaluationProfile, right: EvaluationProfile): boolean {
  return Boolean(left && right) && left.harness === right.harness && left.profileVersion === right.profileVersion &&
    left.model === right.model && left.reasoningEffort === right.reasoningEffort && left.sandbox === right.sandbox &&
    left.contextMode === right.contextMode && left.timeoutSeconds === right.timeoutSeconds
}

export function evaluationResultMatches(definition: EvaluateSetupsPayload, value: EvaluationResultPayload): boolean {
  if (!exactKeys(value, ['suiteId', 'profile', 'observed', 'baseline', 'candidate', 'completedAt']) || value.suiteId !== definition.suiteId ||
    !exactKeys(value.profile, ['harness', 'profileVersion', 'model', 'reasoningEffort', 'sandbox', 'contextMode', 'timeoutSeconds']) || !sameEvaluationProfile(value.profile, definition.profile) ||
    !exactKeys(value.observed, ['harnessVersion', 'model', 'contextMode', 'nativeSkillActivation', 'inheritedInstructionsDigest', 'ambientContextVerified']) ||
    !value.observed || typeof value.observed.harnessVersion !== 'string' || value.observed.harnessVersion.length > 200 ||
    !(value.observed.model === null || typeof value.observed.model === 'string' && value.observed.model.length <= 200) ||
    value.observed.contextMode !== 'skillInstructions' || value.observed.nativeSkillActivation !== false ||
    value.observed.ambientContextVerified !== false || !(value.observed.inheritedInstructionsDigest === null || typeof value.observed.inheritedInstructionsDigest === 'string' && /^sha256:[0-9a-f]{64}$/.test(value.observed.inheritedInstructionsDigest)) ||
    typeof value.completedAt !== 'string' || !Number.isFinite(Date.parse(value.completedAt))) return false
  return (['baseline', 'candidate'] as const).every((side) => {
    const result = value[side]
    return exactKeys(result, ['setupRevisionId', 'status', 'durationMs', 'checks', 'summary', 'error']) && result.setupRevisionId === definition[side].setupRevisionId &&
      ['completed', 'failed', 'timedOut', 'cancelled', 'interrupted'].includes(result.status) &&
      Number.isSafeInteger(result.durationMs) && result.durationMs >= 0 && result.durationMs <= 300_000 &&
      typeof result.summary === 'string' && result.summary.length <= 2_000 &&
      (result.error === null || typeof result.error === 'string' && result.error.length <= 1_000) &&
      Array.isArray(result.checks) && result.checks.length <= 20 &&
      (result.status === 'completed' ? result.checks.length === 3 && ['discount', 'clamp', 'contains'].every((id) => result.checks.filter((check) => check?.id === id).length === 1) : result.checks.length === 0) &&
      result.checks.every((check) => exactKeys(check, ['id', 'label', 'passed']) && typeof check.id === 'string' && check.id.length <= 100 &&
        typeof check.label === 'string' && check.label.length <= 200 && typeof check.passed === 'boolean')
  })
}
