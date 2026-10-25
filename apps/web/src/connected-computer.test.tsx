// @vitest-environment happy-dom
import type { RunnerStatusResponse } from '@ahm/contracts'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ControlPlaneApiError, type ControlPlaneClient } from './api'
import { HelperOnboarding } from './components/HelperOnboarding'
import { useRunnerConnection } from './useRunnerConnection'
import './i18n'

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }))
  localStorage.clear(); sessionStorage.clear()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove(); vi.useRealTimers(); vi.unstubAllGlobals()
})
function computer(deviceId = 'laptop'): RunnerStatusResponse {
  return { deviceId, label: deviceId, status: 'active', enrolledAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
    skillLibrary: null, projectInstances: [], capabilities: { protocolVersion: '1.0', supportedProtocolVersions: ['1.0'], runnerVersion: '0.10.1',
      capabilities: { library: true, scanProject: false, planSetup: false, applyPlan: false, rollbackOperation: false, supportedTools: [] } } }
}
function clientFixture() {
  return { runners: vi.fn().mockResolvedValue([computer()]), runner: vi.fn().mockResolvedValue(computer()),
    createRunnerEnrollment: vi.fn().mockResolvedValue({ enrollmentId: 'new', code: 'abcdefghijklmnop', command: 'ahm connect abcdefghijklmnop --server https://example.com', expiresAt: '2099-01-01T00:00:00Z' }),
    runnerEnrollment: vi.fn().mockResolvedValue({ enrollmentId: 'old', state: 'waiting', deviceId: null, expiresAt: '2099-01-01T00:00:00Z' }) }
}
async function mount(client: ReturnType<typeof clientFixture>) {
  function Fixture() {
    const connection = useRunnerConnection(client as unknown as ControlPlaneClient)
    return <HelperOnboarding connection={connection} connected={Boolean(connection.runner)} initialInstalled onFinish={vi.fn()} />
  }
  await act(async () => root.render(<Fixture />))
}
async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find(button => button.textContent === text)
  expect(button).toBeDefined()
  await act(async () => button!.click())
}

it('uses an existing computer from a fresh browser without creating a pairing link, then restores it', async () => {
  const client = clientFixture()
  client.runners.mockResolvedValue([computer(), computer('desktop')])
  await mount(client)
  expect(container.textContent).toContain('Use laptop')
  expect(container.textContent).toContain('Use desktop')
  expect(client.runner).not.toHaveBeenCalled()
  expect(client.createRunnerEnrollment).not.toHaveBeenCalled()
  expect(container.querySelector('a[href^="ahm:"]')).toBeNull()
  await click('Use laptop')
  expect(container.textContent).toContain('Your computer is ready')
  expect(localStorage.getItem('ahm.runner-device')).toBe('laptop')
  await act(async () => { root.unmount(); root = createRoot(container) })
  await mount(client)
  expect(container.textContent).toContain('Your computer is ready')
  expect(client.createRunnerEnrollment).not.toHaveBeenCalled()
})

it('ignores a stale pairing failure after the user selects an existing computer', async () => {
  sessionStorage.setItem('ahm.runner-enrollment', JSON.stringify({ enrollmentId: 'old', command: 'ahm connect abcdefghijklmnop --server https://example.com', expiresAt: '2099-01-01T00:00:00Z' }))
  let rejectOld!: (error: Error) => void
  const client = clientFixture()
  client.runnerEnrollment.mockImplementation(() => new Promise((_resolve, reject) => { rejectOld = reject }))
  await mount(client)
  await click('Use laptop')
  await act(async () => rejectOld(new ControlPlaneApiError(404, 'Expired enrollment')))
  expect(container.textContent).toContain('Your computer is ready')
  expect(sessionStorage.getItem('ahm.runner-enrollment')).toBeNull()
  expect(localStorage.getItem('ahm.runner-device')).toBe('laptop')
})

it('rechecks a listed computer before selecting it and explains if it went offline', async () => {
  sessionStorage.setItem('ahm.runner-enrollment', JSON.stringify({ enrollmentId: 'old', command: 'ahm connect abcdefghijklmnop --server https://example.com', expiresAt: '2099-01-01T00:00:00Z' }))
  const client = clientFixture()
  client.runner.mockResolvedValue({ ...computer(), lastSeenAt: new Date(Date.now() - 60_000).toISOString() })
  await mount(client)
  await click('Use laptop')
  await act(async () => vi.advanceTimersByTimeAsync(3000))
  expect(container.querySelector('[role=alert]')?.textContent).toContain('no longer available')
  expect(localStorage.getItem('ahm.runner-device')).toBeNull()
  expect(client.createRunnerEnrollment).not.toHaveBeenCalled()
})

it('shows a retry when listing fails and retains an explicit path to connect a new computer', async () => {
  const client = clientFixture()
  client.runners.mockRejectedValueOnce(new Error('Network unavailable'))
  await mount(client)
  expect(container.querySelector('[role=alert]')?.textContent).toContain('Could not load connected computers')
  expect(client.createRunnerEnrollment).not.toHaveBeenCalled()
  await click('Check computers again')
  expect(container.textContent).toContain('Use laptop')
  await click('Connect another computer')
  expect(client.createRunnerEnrollment).toHaveBeenCalledOnce()
  expect(container.querySelector('a[href^="ahm://connect"]')).not.toBeNull()
})
