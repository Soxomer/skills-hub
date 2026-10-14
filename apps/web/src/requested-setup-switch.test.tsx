// @vitest-environment happy-dom
import type { CanonicalPlan, ProjectInstanceOperationsResponse, ProjectSetupStateResponse, RunnerJobStatusResponse } from '@ahm/contracts'
import { act, StrictMode, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ControlPlaneClient } from './api'
import { ControlPlaneApiError } from './api'
import { ProjectSwitchWorkspace } from './components/ProjectSwitchWorkspace'
import { useSetupSwitch } from './useSetupSwitch'
import './i18n'

const date = '2026-10-14T10:00:00Z'
const digest = `sha256:${'a'.repeat(64)}`
function plan(revision = 'historic'): CanonicalPlan {
  return { setupRevisionId: revision, planDigest: digest, actions: [], conflicts: [] }
}
function state(): ProjectSetupStateResponse {
  return { projectId: 'project', assignedSetupRevisionId: 'latest', defaultSetupRevisionId: 'default',
    revisions: ['historic', 'latest', 'default'].map((id, index) => ({ setupId: 'setup', setupRevisionId: id,
      name: id, kind: id === 'default' ? 'default' : 'custom', revisionNumber: index + 1, itemCount: 1, createdAt: date })) }
}
function operations(): ProjectInstanceOperationsResponse {
  return { projectInstanceId: 'checkout', assignedSetupRevisionId: 'latest', materializedSetupRevisionId: 'latest',
    health: 'current', activeOperation: null, reviewedPlan: null, operations: [] }
}
function client() {
  return { setupRevisions: vi.fn().mockResolvedValue(state()), projectOperations: vi.fn().mockResolvedValue(operations()),
    prepareSetupPlan: vi.fn().mockResolvedValue({ jobId: 'prepared' }),
    applySetupPlan: vi.fn().mockResolvedValue({ jobId: 'applied', approvalId: 'approval' }),
    job: vi.fn().mockResolvedValue({ jobId: 'prepared', state: 'pending', result: null, cancelRequested: false }),
    cancelJob: vi.fn(), setupComposer: vi.fn() }
}
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals() })
async function mountHook(api: ReturnType<typeof client>, revision = 'historic') {
  let workflow!: ReturnType<typeof useSetupSwitch>
  function Harness({ requested }: { requested: string }) {
    const value = useSetupSwitch(api as unknown as ControlPlaneClient, 'project', 'checkout', requested)
    useEffect(() => { workflow = value })
    return null
  }
  await act(async () => root.render(<Harness requested={revision} />))
  return { current: () => workflow, render: async (requested: string) => {
    await act(async () => root.render(<Harness requested={requested} />))
  } }
}
async function mountWorkspace(api: ReturnType<typeof client>, revision = 'historic', online = true) {
  await act(async () => root.render(<ProjectSwitchWorkspace client={api as unknown as ControlPlaneClient}
    projectId="project" projectInstanceId="checkout" runnerOnline={online} requestedRevisionId={revision} />))
}
function button(label: string) {
  return [...container.querySelectorAll('button')].find(entry => entry.textContent?.trim() === label)
}

it('locks the exact historical revision without queuing work or changing to latest', async () => {
  const api = client(); const { current } = await mountHook(api)
  expect(current().selectedRevisionId).toBe('historic')
  await act(async () => current().selectRevision('latest'))
  expect(current().selectedRevisionId).toBe('historic')
  expect(api.prepareSetupPlan).not.toHaveBeenCalled(); expect(api.applySetupPlan).not.toHaveBeenCalled()
  await act(async () => { expect(await current().preparePlan('latest')).toBe(false) })
  await act(async () => { expect(await current().preparePlan()).toBe(true) })
  expect(api.prepareSetupPlan).toHaveBeenCalledExactlyOnceWith('checkout', { setupRevisionId: 'historic' })
})

it('ignores a different saved plan and never offers its Apply action', async () => {
  const api = client(); api.projectOperations.mockResolvedValue({ ...operations(), reviewedPlan: { jobId: 'old-plan', plan: plan('latest') } })
  await mountWorkspace(api)
  expect(container.textContent).toContain('historic')
  expect(button('Approve and apply now')).toBeUndefined()
  expect(container.querySelector('select')).toBeNull()
  expect(api.setupComposer).not.toHaveBeenCalled()
  expect(button('Use Default')).toBeUndefined()
  expect(api.prepareSetupPlan).not.toHaveBeenCalled(); expect(api.applySetupPlan).not.toHaveBeenCalled()
})

it('fails closed when the requested revision is unavailable', async () => {
  const api = client(); const { current } = await mountHook(api, 'other-project-default')
  expect(current().selectedRevisionId).toBe('')
  expect(current().requestedRevisionUnavailable).toBe(true)
  await act(async () => { expect(await current().preparePlan('other-project-default')).toBe(false) })
  await act(async () => { expect(await current().applyPlan()).toBe(false) })
  expect(api.prepareSetupPlan).not.toHaveBeenCalled(); expect(api.applySetupPlan).not.toHaveBeenCalled()
})

it('preserves another active operation then permits explicit review without claiming its success', async () => {
  const api = client()
  const active = { ...operations(), activeOperation: { jobId: 'other-apply', kind: 'applyPlan' as const,
    state: 'acknowledged' as const, setupRevisionId: 'latest', cancelRequested: false, issuedAt: date } }
  api.projectOperations.mockResolvedValueOnce(active).mockResolvedValue(operations())
  api.job.mockResolvedValue({ jobId: 'other-apply', state: 'succeeded', cancelRequested: false,
    result: { protocolVersion: '1.0', jobId: 'other-apply', idempotencyKey: 'other', organizationId: 'org',
      deviceId: 'device', projectInstanceId: 'checkout', result: { kind: 'applyReceipt', payload: {
        projectId: 'project', setupRevisionId: 'latest', operationId: 'other-operation', planDigest: digest,
        outcome: 'applied', recoverability: 'notNeeded', actionsApplied: 1, completedAt: date } } } } satisfies RunnerJobStatusResponse)
  const { current } = await mountHook(api)
  expect(current().activeJob?.jobId).toBe('other-apply')
  expect(current().selectedRevisionId).toBe('historic')
  await act(async () => { expect(await current().preparePlan()).toBe(false) })
  await act(async () => { await current().refreshJob() })
  expect(current().activeJob).toBeNull(); expect(current().receipt).toBeNull()
  expect(current().selectedRevisionId).toBe('historic')
  expect(api.prepareSetupPlan).not.toHaveBeenCalled()
  await act(async () => { expect(await current().preparePlan()).toBe(true) })
  expect(api.prepareSetupPlan).toHaveBeenCalledWith('checkout', { setupRevisionId: 'historic' })
})

it('uses the requested plan digest only after a separate explicit Apply', async () => {
  const api = client(); api.projectOperations.mockResolvedValue({ ...operations(), reviewedPlan: { jobId: 'historic-plan', plan: plan() } })
  const { current } = await mountHook(api)
  expect(current().plan?.setupRevisionId).toBe('historic')
  expect(api.applySetupPlan).not.toHaveBeenCalled()
  await act(async () => { expect(await current().applyPlan()).toBe(true) })
  expect(api.applySetupPlan).toHaveBeenCalledExactlyOnceWith('checkout', { planJobId: 'historic-plan', planDigest: digest })
})

it('keeps review unavailable while the runner is offline', async () => {
  const api = client(); await mountWorkspace(api, 'historic', false)
  const prepare = button('Prepare plan')
  expect(prepare).toBeDefined(); expect(prepare!.disabled).toBe(true)
  expect(api.prepareSetupPlan).not.toHaveBeenCalled(); expect(api.applySetupPlan).not.toHaveBeenCalled()
})

it('ignores late revision responses after the requested context changes', async () => {
  const api = client()
  let resolve!: (value: ProjectSetupStateResponse) => void
  api.setupRevisions.mockReturnValueOnce(new Promise<ProjectSetupStateResponse>(done => { resolve = done }))
  const { current, render } = await mountHook(api)
  await render('latest')
  await act(async () => resolve({ ...state(), revisions: state().revisions.filter(revision => revision.setupRevisionId === 'historic') }))
  expect(current().selectedRevisionId).toBe('latest')
  expect(current().requestedRevisionUnavailable).toBe(false)
  expect(api.prepareSetupPlan).not.toHaveBeenCalled()
})

it('does not automatically recover an obsolete job after its handoff unmounts', async () => {
  const api = client()
  api.projectOperations.mockResolvedValue({ ...operations(), activeOperation: {
    jobId: 'apply', kind: 'applyPlan', state: 'acknowledged', setupRevisionId: 'historic', cancelRequested: false, issuedAt: date } })
  let resolve!: (value: RunnerJobStatusResponse) => void
  api.job.mockReturnValue(new Promise<RunnerJobStatusResponse>(done => { resolve = done }))
  const { current } = await mountHook(api)
  let request!: Promise<void>
  await act(async () => { request = current().refreshJob() })
  await act(async () => root.render(null))
  await act(async () => {
    resolve({ jobId: 'apply', state: 'failed', cancelRequested: false,
      result: { protocolVersion: '1.0', jobId: 'apply', idempotencyKey: 'apply', organizationId: 'org',
        deviceId: 'device', projectInstanceId: 'checkout', result: { kind: 'error', payload: {
          code: 'planDigestMismatch', message: 'Changed files', retryable: true, recoverability: 'notNeeded' } } } })
    await request
  })
  expect(api.prepareSetupPlan).not.toHaveBeenCalled(); expect(api.applySetupPlan).not.toHaveBeenCalled()
})

it('loads the exact requested selection under StrictMode effect replay', async () => {
  const api = client()
  await act(async () => root.render(<StrictMode><ProjectSwitchWorkspace client={api as unknown as ControlPlaneClient}
    projectId="project" projectInstanceId="checkout" runnerOnline requestedRevisionId="historic" /></StrictMode>))
  expect(container.textContent).toContain('historic')
  expect(button('Prepare plan')?.disabled).toBe(false)
  expect(api.prepareSetupPlan).not.toHaveBeenCalled(); expect(api.applySetupPlan).not.toHaveBeenCalled()
})

it.each([true, false])('requires explicit new review after a mounted existing Apply fails (online=%s)', async online => {
  vi.useFakeTimers()
  const api = client()
  api.projectOperations.mockResolvedValueOnce({ ...operations(), activeOperation: {
    jobId: 'existing-apply', kind: 'applyPlan', state: 'acknowledged', setupRevisionId: 'historic', cancelRequested: false, issuedAt: date } })
  api.job.mockResolvedValue({ jobId: 'existing-apply', state: 'failed', cancelRequested: false,
    result: { protocolVersion: '1.0', jobId: 'existing-apply', idempotencyKey: 'apply', organizationId: 'org',
      deviceId: 'device', projectInstanceId: 'checkout', result: { kind: 'error', payload: {
        code: 'planDigestMismatch', message: 'Changed files', retryable: true, recoverability: 'notNeeded' } } } } satisfies RunnerJobStatusResponse)
  await mountWorkspace(api, 'historic', online)
  await act(async () => { await vi.advanceTimersByTimeAsync(800) })
  expect(api.job).toHaveBeenCalledWith('existing-apply')
  expect(container.querySelector('[role=alert]')).not.toBeNull()
  expect(api.prepareSetupPlan).not.toHaveBeenCalled(); expect(api.applySetupPlan).not.toHaveBeenCalled()
  expect(button('Prepare plan')?.disabled).toBe(!online)
  if (online) {
    await act(async () => button('Prepare plan')!.click())
    expect(api.prepareSetupPlan).toHaveBeenCalledExactlyOnceWith('checkout', { setupRevisionId: 'historic' })
  }
})

it('retains direct stale Apply failure without automatically preparing another plan', async () => {
  vi.useFakeTimers()
  const api = client()
  api.projectOperations.mockResolvedValue({ ...operations(), reviewedPlan: { jobId: 'historic-plan', plan: plan() } })
  api.applySetupPlan.mockRejectedValue(new ControlPlaneApiError(409, 'Changed files', 'planDigestMismatch'))
  const { current } = await mountHook(api)
  await act(async () => { expect(await current().applyPlan()).toBe(false) })
  expect(current().error?.code).toBe('planDigestMismatch')
  expect(current().plan).toBeNull(); expect(current().selectedRevisionId).toBe('historic')
  expect(api.prepareSetupPlan).not.toHaveBeenCalled()
  await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
  expect(api.projectOperations).toHaveBeenCalledTimes(2)
  expect(current().plan).toBeNull()
  await act(async () => { expect(await current().applyPlan()).toBe(false) })
  expect(api.applySetupPlan).toHaveBeenCalledTimes(1)
  expect(api.prepareSetupPlan).not.toHaveBeenCalled()
  await act(async () => { expect(await current().preparePlan()).toBe(true) })
  expect(api.prepareSetupPlan).toHaveBeenCalledExactlyOnceWith('checkout', { setupRevisionId: 'historic' })
})
