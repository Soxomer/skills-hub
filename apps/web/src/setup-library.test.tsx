// @vitest-environment happy-dom
import type { SetupComposerItem, SetupDetail } from '@ahm/contracts'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ControlPlaneApiError, type ControlPlaneClient } from './api'
import { SetupLibrary } from './components/SetupLibrary'
import './i18n'

const item: SetupComposerItem = { sourceSetupRevisionId: 'v1', sourceSetupName: 'Daily', sourceRevisionNumber: 1,
  artifactId: 'skill', artifactKind: 'skill', portableSource: null, contentDigest: 'sha256:abc', toolId: 'codex', targetName: 'review' }
const extra: SetupComposerItem = { ...item, artifactId: 'other', targetName: 'testing' }
const revision = { setupId: 'daily', setupRevisionId: 'v1', name: 'Daily', kind: 'custom' as const, revisionNumber: 1, itemCount: 1, createdAt: '2026-09-08T12:00:00Z', items: [item] }
const detail: SetupDetail = { setupId: 'daily', name: 'Daily', kind: 'custom', defaultProjectId: null, initialSetupRevisionId: 'v1', revisions: [revision], projects: [{ projectId: 'project', name: 'My project', setupRevisionId: 'v1' }] }
function mockClient() {
  return {
    setups: vi.fn().mockResolvedValue({ setups: [{ setupId: 'daily', name: 'Daily', kind: 'custom', defaultProjectId: null, latestRevision: revision, projectCount: 1 }] }),
    setup: vi.fn().mockResolvedValue(detail), setupComposer: vi.fn().mockResolvedValue({ items: [item, extra] }),
    setupArtifact: vi.fn().mockResolvedValue({ contentDigest: item.contentDigest, entries: [{ path: 'SKILL.md', kind: 'file', contentBase64: btoa('# Review\n<script>unsafe()</script>') }] }),
    publishSetupRevision: vi.fn().mockResolvedValue({ ...revision, setupRevisionId: 'v2', revisionNumber: 2 }),
    createSetup: vi.fn().mockResolvedValue({ ...revision, setupId: 'cloned' }),
  }
}
let root: Root
let container: HTMLDivElement
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
async function mount(client = mockClient()) {
  await act(async () => root.render(<SetupLibrary client={client as unknown as ControlPlaneClient} onProjects={vi.fn()} />))
  return client
}
async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find((entry) => entry.textContent?.includes(text))
  expect(button, text).toBeTruthy()
  await act(async () => button!.click())
}
async function chooseExtra() {
  const checkbox = container.querySelectorAll<HTMLInputElement>('input[type=checkbox]')[1]
  await act(async () => checkbox.click())
}

it('browses saved contents and pinned project usage without any runner API', async () => {
  const client = await mount()
  await click('Daily')
  expect(container.textContent).toContain('My project')
  await click('Inspect contents')
  expect(client.setupArtifact).toHaveBeenCalledWith('daily', 'v1', item.contentDigest)
  expect(container.querySelector('pre')?.textContent).toContain('<script>unsafe()</script>')
  expect(container.querySelector('script')).toBeNull()
})

it('publishes selected additions against the exact latest revision without applying', async () => {
  const client = await mount()
  await click('Daily'); await click('Edit selection'); await chooseExtra()
  expect(container.textContent).toContain('Added')
  await click('Publish version 2')
  expect(client.publishSetupRevision).toHaveBeenCalledWith('daily', { expectedRevisionNumber: 1, items: [item, extra].map(({ sourceSetupRevisionId, artifactId, contentDigest, toolId, targetName }) => ({ sourceSetupRevisionId, artifactId, contentDigest, toolId, targetName })) })
  expect(container.textContent).toContain('My project')
})

it('preserves the draft and explains a stale publication conflict', async () => {
  const client = mockClient()
  client.publishSetupRevision.mockRejectedValue(new ControlPlaneApiError(409, 'stale', 'setupRevisionConflict'))
  await mount(client); await click('Daily'); await click('Edit selection'); await chooseExtra(); await click('Publish version 2')
  expect(container.querySelector('[role=alert]')?.textContent).toContain('A newer version was published')
  expect([...container.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].every((input) => input.checked)).toBe(true)
})

it('compares historical revisions and keeps the initial Default visible', async () => {
  const client = mockClient()
  client.setup.mockResolvedValue({ ...detail, kind: 'default', revisions: [{ ...revision, kind: 'default' }, { ...revision, kind: 'default', setupRevisionId: 'v2', revisionNumber: 2, items: [extra] }] })
  await mount(client); await click('Daily')
  expect(container.textContent).toContain('Initial Default')
  expect(container.textContent).toContain('Changes from version 1')
  expect(container.textContent).toContain('Removed')
  expect(container.textContent).toContain('Added')
})

it('does not let a late detail response replace the returned library', async () => {
  const client = mockClient()
  let resolve!: (value: SetupDetail) => void
  client.setup.mockReturnValue(new Promise<SetupDetail>((done) => { resolve = done }))
  await mount(client); await click('Daily'); await click('Back to Setups')
  await act(async () => resolve(detail))
  expect(container.textContent).toContain('Find a Setup')
  expect(container.textContent).not.toContain('Used by projects')
})

it('offers recovery when loading fails', async () => {
  const client = mockClient(); client.setups.mockRejectedValueOnce(new Error('offline'))
  await mount(client)
  expect(container.querySelector('[role=alert]')).toBeTruthy()
  await click('Retry')
  expect(container.textContent).toContain('Daily')
})

it('refreshes the latest version after cancelling a stale editor', async () => {
  const client = mockClient()
  client.publishSetupRevision.mockRejectedValue(new ControlPlaneApiError(409, 'stale', 'setupRevisionConflict'))
  await mount(client); await click('Daily'); await click('Edit selection'); await chooseExtra(); await click('Publish version 2')
  client.setup.mockResolvedValue({ ...detail, revisions: [{ ...revision, setupRevisionId: 'v2', revisionNumber: 2 }, revision] })
  await click('Cancel'); await click('Edit selection'); await chooseExtra(); await click('Publish version 3')
  expect(client.publishSetupRevision).toHaveBeenLastCalledWith('daily', expect.objectContaining({ expectedRevisionNumber: 2 }))
})

it('can republish an older selection and reviews its difference from the latest version', async () => {
  const client = mockClient()
  client.setup.mockResolvedValue({ ...detail, revisions: [{ ...revision, setupRevisionId: 'v2', revisionNumber: 2, items: [extra] }, revision] })
  await mount(client); await click('Daily')
  const select = container.querySelector('select')!
  await act(async () => { select.value = 'v1'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await click('Edit selection')
  expect(container.textContent).toContain('Changes from version 2')
  expect(container.textContent).toContain('Removed')
  await click('Publish version 3')
  expect(client.publishSetupRevision).toHaveBeenCalledWith('daily', expect.objectContaining({ expectedRevisionNumber: 2, items: [expect.objectContaining({ targetName: 'review' })] }))
})

it('clones the selected version into a separately named Setup', async () => {
  const client = await mount()
  await click('Daily'); await click('Clone Setup')
  const name = container.querySelector<HTMLInputElement>('input:not([type])')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'New setup')
    name.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click('Create Setup')
  expect(client.createSetup).toHaveBeenCalledWith({ name: 'New setup', items: [expect.objectContaining({ targetName: 'review' })] })
  expect(client.publishSetupRevision).not.toHaveBeenCalled()
})
