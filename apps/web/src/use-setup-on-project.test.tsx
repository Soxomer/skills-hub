// @vitest-environment happy-dom
import type { ProjectSummary, RunnerStatusResponse, SetupDetail } from '@ahm/contracts'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ControlPlaneClient } from './api'
import { SetupLibrary } from './components/SetupLibrary'
import './i18n'

const date = '2026-10-14T10:00:00Z'
const old = { setupId: 'daily', setupRevisionId: 'v1', name: 'Daily', kind: 'custom' as const, revisionNumber: 1, itemCount: 0, createdAt: date, items: [] }
const latest = { ...old, setupRevisionId: 'v2', revisionNumber: 2 }
const detail: SetupDetail = { setupId: 'daily', name: 'Daily', kind: 'custom', defaultProjectId: null, initialSetupRevisionId: 'v1', revisions: [latest, old], projects: [] }
const projects: ProjectSummary[] = ['A', 'B'].map(projectId => ({ projectId, name: `Project ${projectId}`, repositoryIdentity: null, createdAt: date, updatedAt: date,
  defaultRevision: { setupId: `default-${projectId}`, setupRevisionId: `default-${projectId}`, revisionNumber: 1, sourceScanJobId: null, itemCount: 0, createdAt: date } }))
const runner: RunnerStatusResponse = { deviceId: 'device', label: 'My computer', status: 'active', enrolledAt: date, lastSeenAt: date, capabilities: null,
  projectInstances: ['A-1', 'A-2', 'B-1'].map(id => ({ projectInstanceId: id, projectId: id[0], registeredAt: date, lastSeenAt: date })) }
function mockClient() {
  return {
    setups: vi.fn().mockResolvedValue({ setups: [{ ...detail, latestRevision: latest, projectCount: 0 }] }),
    setup: vi.fn().mockResolvedValue(detail), projects: vi.fn().mockResolvedValue({ projects }),
    setupRevisions: vi.fn().mockResolvedValue({ projectId: 'A', defaultSetupRevisionId: 'default-A', assignedSetupRevisionId: 'v2', revisions: [latest, old] }),
    projectOperations: vi.fn().mockResolvedValue({ projectInstanceId: 'A-2', assignedSetupRevisionId: 'v2', materializedSetupRevisionId: 'v2', health: 'current', activeOperation: null, reviewedPlan: null, operations: [] }),
    prepareSetupPlan: vi.fn().mockResolvedValue({ jobId: 'plan' }), applySetupPlan: vi.fn(),
    job: vi.fn().mockResolvedValue({ jobId: 'plan', state: 'pending', result: null, cancelRequested: false }),
    createProject: vi.fn(), scanProject: vi.fn(), captureDefault: vi.fn(),
  }
}
let root: Root
let container: HTMLDivElement
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
async function mount(client = mockClient(), device: RunnerStatusResponse | null = runner, online = true, onProjects = vi.fn(), active = true) {
  await act(async () => root.render(<SetupLibrary client={client as unknown as ControlPlaneClient} runner={device} runnerOnline={online} onProjects={onProjects} active={active} />))
  return client
}
function button(text: string) {
  const result = [...container.querySelectorAll('button')].find(value => value.textContent?.trim() === text || (text === 'Daily' && value.matches('.library-row') && value.querySelector('strong')?.textContent === text))
  expect(result, text).toBeDefined()
  return result!
}
async function click(text: string) { await act(async () => button(text).click()) }
async function select(label: string, value: string) {
  const field = [...container.querySelectorAll('label')].find(entry => entry.textContent?.startsWith(label))?.querySelector('select')
  expect(field, label).toBeTruthy()
  await act(async () => { field!.value = value; field!.dispatchEvent(new Event('change', { bubbles: true })) })
}
async function openHistorical() { await click('Daily'); await select('Version history', 'v1'); await click('Use this Setup') }
async function destination() { await select('Project', 'A'); await select('Connected checkout', 'A-2') }

it('hands the exact historical version and explicitly selected checkout to reviewed planning', async () => {
  const client = await mount()
  await openHistorical()
  expect(container.textContent).toContain('Daily · Version 1')
  expect(button('Continue to review').disabled).toBe(true)
  await select('Project', 'A')
  expect(button('Continue to review').disabled).toBe(true)
  await select('Connected checkout', 'A-2'); await click('Continue to review')
  expect(client.projectOperations).toHaveBeenCalledWith('A-2')
  expect(client.prepareSetupPlan).not.toHaveBeenCalled()
  expect(client.applySetupPlan).not.toHaveBeenCalled()
  await click('Prepare plan')
  expect(client.prepareSetupPlan).toHaveBeenCalledWith('A-2', { setupRevisionId: 'v1' })
  expect(client.applySetupPlan).not.toHaveBeenCalled()
  expect(client.scanProject).not.toHaveBeenCalled()
  expect(client.createProject).not.toHaveBeenCalled()
})

it('keeps the historical selection on returning to the Setup', async () => {
  await mount(); await openHistorical(); await destination(); await click('Back to this Setup')
  expect(container.querySelector('select')?.value).toBe('v1')
})

it('refreshes destinations on reentry without losing the selected project, checkout, or exact version', async () => {
  const client = await mount(); await openHistorical(); await destination()
  await mount(client, runner, true, vi.fn(), false)
  client.projects.mockResolvedValue({ projects: [...projects, { ...projects[0], projectId: 'C', name: 'Project C' }] })
  expect(client.projects).toHaveBeenCalledOnce()
  await mount(client)
  expect(client.projects).toHaveBeenCalledTimes(2)
  expect(container.querySelectorAll('select')[0].value).toBe('A')
  expect(container.querySelectorAll('select')[1].value).toBe('A-2')
  expect(container.textContent).toContain('Project C')
  expect(container.textContent).toContain('Daily · Version 1')
  expect(client.prepareSetupPlan).not.toHaveBeenCalled()
  expect(client.applySetupPlan).not.toHaveBeenCalled()
})

it('clears checkout selection when choosing another project', async () => {
  const client = await mount(); await openHistorical(); await destination(); await select('Project', 'B')
  expect(button('Continue to review').disabled).toBe(true)
  expect(client.prepareSetupPlan).not.toHaveBeenCalled()
})

it.each(['offline', 'revoked', 'absent'] as const)('explains the %s computer prerequisite without running work', async state => {
  const onProjects = vi.fn(); const client = mockClient()
  await mount(client, state === 'absent' ? null : { ...runner, status: state === 'revoked' ? 'revoked' : 'active' }, false, onProjects)
  await openHistorical()
  if (state !== 'absent') await destination()
  expect(button('Continue to review').disabled).toBe(true)
  expect(container.querySelector('[role=status]')).not.toBeNull()
  await click('Open Projects & connection'); expect(onProjects).toHaveBeenCalledOnce()
  expect(client.prepareSetupPlan).not.toHaveBeenCalled()
})

it.each(['checkout', 'Default'] as const)('explains a missing %s and does not invent onboarding work', async missing => {
  const client = mockClient()
  if (missing === 'Default') client.projects.mockResolvedValue({ projects: projects.map(value => ({ ...value, defaultRevision: null })) })
  await mount(client, missing === 'checkout' ? { ...runner, projectInstances: [] } : runner)
  await openHistorical(); await select('Project', 'A')
  expect(container.textContent).toContain(missing === 'checkout' ? 'no checkout' : 'starting Default')
  expect(button('Continue to review').disabled).toBe(true)
  expect(client.scanProject).not.toHaveBeenCalled()
})

it('restricts a project Default to its owning project', async () => {
  const client = mockClient()
  client.setup.mockResolvedValue({ ...detail, kind: 'default', defaultProjectId: 'A', revisions: [ { ...old, kind: 'default' } ] })
  await mount(client); await click('Daily'); await click('Use this Setup')
  expect(container.textContent).toContain('only be used on its original project')
  expect([...container.querySelectorAll('option')].map(value => value.value)).toEqual(['', 'A'])
})

it('invalidates the destination when the connected device is replaced', async () => {
  const client = await mount(); await openHistorical(); await destination(); await click('Continue to review')
  await mount(client, { ...runner, deviceId: 'other-device' })
  expect(container.textContent).toContain('no longer the selected destination')
  expect(container.querySelector('.setup-switch')).toBeNull()
  expect(client.prepareSetupPlan).not.toHaveBeenCalled()
})

it('offers project load retry and an actionable empty state', async () => {
  const client = mockClient(); client.projects.mockRejectedValueOnce(new Error('network')).mockResolvedValue({ projects: [] })
  await mount(client); await openHistorical(); expect(container.querySelector('[role=alert]')).toBeTruthy()
  await click('Retry'); expect(container.textContent).toContain('No eligible projects')
  expect(button('Open Projects & connection')).toBeTruthy()
})

it('requires checkout selection again if the computer changes before continuing', async () => {
  const client = await mount(); await openHistorical(); await destination()
  await mount(client, { ...runner, deviceId: 'replacement' })
  expect(button('Continue to review').disabled).toBe(true)
  expect(container.querySelector<HTMLSelectElement>('label:last-of-type select')?.value).toBe('')
  expect(client.prepareSetupPlan).not.toHaveBeenCalled()
})

it('ignores a late project list after returning to the selected Setup', async () => {
  const client = mockClient()
  let resolve!: (value: { projects: ProjectSummary[] }) => void
  client.projects.mockReturnValue(new Promise(done => { resolve = done }))
  await mount(client); await openHistorical(); await click('Back to this Setup')
  await act(async () => resolve({ projects }))
  expect(container.querySelector('select')?.value).toBe('v1')
  expect(container.textContent).not.toContain('Continue to review')
})
