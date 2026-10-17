// @vitest-environment happy-dom
import type { EvaluationSummary, RunnerStatusResponse, SetupDetail } from '@ahm/contracts'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ControlPlaneApiError, type ControlPlaneClient } from './api'
import { SetupLibrary } from './components/SetupLibrary'
import { SetupEvaluation } from './components/SetupEvaluation'
import './i18n'

const date = '2026-10-15T10:00:00Z'
const old = { setupId: 'daily', setupRevisionId: 'v1', name: 'Daily', kind: 'custom' as const, revisionNumber: 1, itemCount: 0, createdAt: date, items: [] }
const latest = { ...old, setupRevisionId: 'v2', revisionNumber: 2 }
const detail: SetupDetail = { setupId: 'daily', name: 'Daily', kind: 'custom', defaultProjectId: null, initialSetupRevisionId: 'v1', revisions: [latest, old], projects: [] }
const runner: RunnerStatusResponse = { deviceId: 'device', label: 'Computer', status: 'active', enrolledAt: date, lastSeenAt: date, projectInstances: [],
  capabilities: { protocolVersion: '1.0', supportedProtocolVersions: ['1.0'], runnerVersion: '0.10.0', capabilities: { evaluateSetups: true, library: true, scanProject: true, planSetup: true, applyPlan: true, rollbackOperation: true, supportedTools: ['codex'] } } }
const saved: EvaluationSummary = { jobId: 'job', deviceId: 'device', createdAt: date, state: 'succeeded', cancelRequested: false,
  definition: { baseline: { ...latest, items: [] }, candidate: { ...old, items: [] }, suiteId: 'code-review-v1', repetitions: 1,
    profile: { harness: 'codex', profileVersion: 1, model: 'test-model', reasoningEffort: 'medium', sandbox: 'read-only', contextMode: 'skillInstructions', timeoutSeconds: 120 } },
  result: { kind: 'evaluationResult', payload: { suiteId: 'code-review-v1', profile: { harness: 'codex', profileVersion: 1, model: 'test-model', reasoningEffort: 'medium', sandbox: 'read-only', contextMode: 'skillInstructions', timeoutSeconds: 120 }, observed: { harnessVersion: 'codex-test', model: null, contextMode: 'skillInstructions', nativeSkillActivation: false, inheritedInstructionsDigest: null, ambientContextVerified: false }, completedAt: date,
    baseline: { setupRevisionId: 'v2', status: 'completed', durationMs: 1000, checks: [{ id: 'discount', label: 'Discount check', passed: false }], summary: 'Baseline evidence', error: null },
    candidate: { setupRevisionId: 'v1', status: 'timedOut', durationMs: 120000, checks: [], summary: '', error: 'Time limit reached' } } } }

function mockClient() {
  return { setups: vi.fn().mockResolvedValue({ setups: [{ ...detail, latestRevision: latest, projectCount: 0 }] }), setup: vi.fn().mockResolvedValue(detail),
    evaluations: vi.fn().mockResolvedValue({ evaluations: [] }), createEvaluation: vi.fn().mockResolvedValue(saved), cancelJob: vi.fn().mockResolvedValue(undefined), applySetupPlan: vi.fn() }
}
let root: Root
let container: HTMLDivElement
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals() })
async function mount(client = mockClient(), device: RunnerStatusResponse | null = runner, online = true) {
  await act(async () => root.render(<SetupLibrary client={client as unknown as ControlPlaneClient} runner={device} runnerOnline={online} onProjects={vi.fn()} />))
  return client
}
function button(text: string) {
  const result = [...container.querySelectorAll('button')].find(value => value.textContent?.trim() === text || (text === 'Daily' && value.matches('.library-row')))
  expect(result, text).toBeDefined(); return result!
}
async function click(text: string) { await act(async () => button(text).click()) }
async function field(label: string, value: string) {
  const input = [...container.querySelectorAll('label')].find(entry => entry.textContent?.startsWith(label))?.querySelector('select,input') as HTMLInputElement | HTMLSelectElement
  expect(input, label).toBeTruthy()
  await act(async () => {
    if (input instanceof HTMLInputElement) Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    else input.value = value
    input.dispatchEvent(new Event(input instanceof HTMLInputElement ? 'input' : 'change', { bubbles: true }))
  })
}
async function openHistorical() { await click('Daily'); await field('Version history', 'v1'); await click('Evaluate instructions') }
async function configure() {
  await field('Baseline Setup version', 'v2'); await field('Codex model identifier', 'test-model')
  await act(async () => container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click())
}
async function submit() { await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))) }

it('evaluates the exact historical revision only after explicit baseline/profile/consent', async () => {
  const client = await mount(); await openHistorical()
  expect(container.textContent).toContain('Candidate: Daily · Version 1')
  expect(button('Start comparison').disabled).toBe(true)
  expect(client.createEvaluation).not.toHaveBeenCalled()
  await configure(); expect(button('Start comparison').disabled).toBe(false); await submit()
  expect(client.createEvaluation).toHaveBeenCalledWith(expect.objectContaining({ baseline: { setupId: 'daily', setupRevisionId: 'v2' }, candidate: { setupId: 'daily', setupRevisionId: 'v1' }, profile: expect.objectContaining({ harness: 'codex', model: 'test-model', timeoutSeconds: 120 }) }))
  expect(client.applySetupPlan).not.toHaveBeenCalled()
  expect(button('Start comparison').disabled).toBe(true)
})

it('reuses the same idempotency key when an unchanged start has an uncertain network result', async () => {
  const client = mockClient(); client.createEvaluation.mockRejectedValueOnce(new Error('network'))
  await mount(client); await openHistorical(); await configure(); await submit(); await submit()
  expect(client.createEvaluation).toHaveBeenCalledTimes(2)
  expect(client.createEvaluation.mock.calls[0][0].idempotencyKey).toBe(client.createEvaluation.mock.calls[1][0].idempotencyKey)
})

it('explains missing captured content without encouraging ineffective network retries', async () => {
  const client = mockClient(); client.createEvaluation.mockRejectedValue(new ControlPlaneApiError(409, 'Missing artifact', 'evaluationCaptureUnavailable'))
  await mount(client); await openHistorical(); await configure(); await submit()
  expect(container.querySelector('[role=alert]')?.textContent).toContain('Capture the skill again through Add to Setup')
  expect(container.querySelector('details')?.textContent).toContain('return values.indexOf(value) > 0;')
  expect(container.textContent).toContain('macOS evaluation is not supported yet')
})

it('keeps evidence readable offline and distinguishes task failure from timeout', async () => {
  const client = mockClient(); client.evaluations.mockResolvedValue({ evaluations: [saved] })
  await mount(client, runner, false); await openHistorical()
  expect(container.textContent).toContain('Baseline evidence')
  expect(container.textContent).toContain('Discount check: Not passed')
  expect(container.textContent).toContain('Time limit reached')
  expect(container.textContent).toContain('Reported model: Not reported')
  expect(button('Start comparison').disabled).toBe(true)
})

it('restores saved history after leaving and returning to the exact Setup version', async () => {
  const client = mockClient(); client.evaluations.mockResolvedValue({ evaluations: [saved] })
  await mount(client); await openHistorical(); await click('Back to this Setup'); await click('Evaluate instructions')
  expect(client.evaluations).toHaveBeenLastCalledWith('v1')
  expect(container.textContent).toContain('Baseline evidence')
})

it('requires consent again if the connected execution device changes', async () => {
  const client = await mount(); await openHistorical(); await configure()
  await mount(client, { ...runner, deviceId: 'replacement' })
  expect(button('Start comparison').disabled).toBe(true)
  expect(container.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(false)
})

it('hides previous workspace evidence and disables all execution when the API client changes', async () => {
  const client = mockClient(); client.evaluations.mockResolvedValue({ evaluations: [saved] })
  await mount(client); await openHistorical(); await configure()
  const replacement = mockClient(); replacement.setup.mockImplementation(() => new Promise(() => undefined))
  await mount(replacement)
  expect(container.textContent).toContain('workspace connection changed')
  expect(container.textContent).not.toContain('Baseline evidence')
  expect(container.querySelector('form')).toBeNull()
  expect(replacement.createEvaluation).not.toHaveBeenCalled()
  expect(replacement.evaluations).not.toHaveBeenCalled()
})

it('shows a pending saved comparison and lets the user explicitly cancel it', async () => {
  const client = mockClient(); client.evaluations.mockResolvedValue({ evaluations: [{ ...saved, state: 'pending', result: null }] })
  await mount(client); await openHistorical(); await click('Cancel comparison')
  expect(client.cancelJob).toHaveBeenCalledWith('job')
  expect(client.createEvaluation).not.toHaveBeenCalled()
})

it('rejects unsupported Setup content without silently dropping it', async () => {
  const client = mockClient()
  client.setup.mockResolvedValue({ ...detail, revisions: [{ ...old, items: [{ toolId: 'claude_code', artifactKind: 'skill', artifactId: 'a', contentDigest: 'digest', targetName: 'review' }] }, latest] })
  await mount(client); await openHistorical(); await configure()
  expect(container.textContent).toContain('nothing is silently omitted')
  expect(button('Start comparison').disabled).toBe(true)
})

it('keeps missing prerequisites beside Start and clears them as the form becomes ready', async () => {
  await mount(); await openHistorical()
  const prerequisites = () => container.querySelector('#evaluation-prerequisites')!
  expect(button('Start comparison').getAttribute('aria-describedby')).toBe(prerequisites().id)
  expect(prerequisites().textContent).toContain('Choose a baseline version.')
  expect(prerequisites().textContent).toContain('Enter a valid Codex model identifier.')
  expect(prerequisites().textContent).toContain('Confirm use of your Codex allowance.')
  await field('Baseline Setup version', 'v2')
  expect(prerequisites().textContent).not.toContain('Choose a baseline version.')
  await field('Codex model identifier', 'invalid model')
  expect(prerequisites().textContent).toContain('Enter a valid Codex model identifier.')
  await field('Codex model identifier', 'test-model')
  expect(prerequisites().textContent).not.toContain('Enter a valid Codex model identifier.')
  await act(async () => container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click())
  expect(prerequisites().textContent).toContain('Ready to run both versions on Computer.')
  expect(button('Start comparison').disabled).toBe(false)
  await field('Reasoning effort', 'high')
  expect(prerequisites().textContent).toContain('Confirm use of your Codex allowance.')
  expect(button('Start comparison').disabled).toBe(true)
})

it('shows fixed shared Codex settings and keeps result diagnostics collapsed', async () => {
  const client = mockClient(); client.evaluations.mockResolvedValue({ evaluations: [saved] })
  await mount(client); await openHistorical()
  const settings = container.querySelector('.evaluation-fixed-settings')!
  expect(settings.textContent).toContain('Codex · fixed for this pilot')
  expect(settings.textContent).toContain('Read-only · tools restricted')
  expect(settings.textContent).toContain('One per version · 120 seconds each')
  const diagnostics = container.querySelector<HTMLDetailsElement>('.evaluation-run-details')!
  expect(diagnostics.open).toBe(false)
  expect(diagnostics.textContent).toContain('Reported model: Not reported')
  expect(diagnostics.textContent).toContain('Baseline: v2 · Candidate: v1')
  const resultSides = container.querySelectorAll('.evaluation-result-side')
  expect(resultSides[0].textContent).toContain('Daily · Version 2')
  expect(resultSides[0].textContent).toContain('0 of 1 task checks passed')
  expect(resultSides[1].textContent).toContain('Daily · Version 1')
  expect(resultSides[1].textContent).toContain('No task checks were recorded.')
  expect(resultSides[1].textContent).not.toContain('0 of')
})

it('refreshes retained evaluation data on reentry and stops polling while inactive without losing the form', async () => {
  vi.useFakeTimers()
  const client = mockClient()
  client.evaluations.mockResolvedValue({ evaluations: [{ ...saved, state: 'pending', result: null }] })
  const renderEvaluation = async (active: boolean) => {
    await act(async () => root.render(<SetupEvaluation client={client as unknown as ControlPlaneClient} candidate={old} runner={runner} runnerOnline active={active} onBack={vi.fn()} onProjects={vi.fn()} />))
  }
  await renderEvaluation(false)
  expect(client.setups).not.toHaveBeenCalled()
  expect(client.evaluations).not.toHaveBeenCalled()
  await renderEvaluation(true)
  await configure()
  expect(client.evaluations).toHaveBeenCalledTimes(1)
  await renderEvaluation(false)
  await act(async () => vi.advanceTimersByTimeAsync(6000))
  expect(client.evaluations).toHaveBeenCalledTimes(1)

  client.evaluations.mockResolvedValue({ evaluations: [saved] })
  await renderEvaluation(true)
  expect(client.setups).toHaveBeenCalledTimes(2)
  expect(client.evaluations).toHaveBeenCalledTimes(2)
  expect(container.textContent).toContain('Baseline evidence')
  expect(container.querySelector<HTMLSelectElement>('select')!.value).toBe('v2')
  expect(container.querySelector<HTMLInputElement>('input:not([type=checkbox])')!.value).toBe('test-model')
  expect(container.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(true)
  expect(button('Start comparison').disabled).toBe(false)

  await renderEvaluation(false)
  await renderEvaluation(true)
  expect(client.setups).toHaveBeenCalledTimes(3)
  expect(client.evaluations).toHaveBeenCalledTimes(3)
  await act(async () => vi.advanceTimersByTimeAsync(6000))
  expect(client.evaluations).toHaveBeenCalledTimes(3)
})
