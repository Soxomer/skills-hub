// @vitest-environment happy-dom
import type { SetupComposerItem } from '@ahm/contracts'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ControlPlaneClient } from './api'
import { App } from './App'
import './i18n'

const connection = vi.hoisted(() => ({
  enrollment: null, status: null, runner: null, creating: false, error: null,
  createEnrollment: vi.fn(), refresh: vi.fn().mockResolvedValue(undefined), reset: vi.fn(),
}))
vi.mock('./useRunnerConnection', () => ({ useRunnerConnection: () => connection }))
vi.mock('./hub/web-update', () => ({
  getWebVersion: vi.fn().mockResolvedValue('test'), checkForWebUpdate: vi.fn().mockResolvedValue(null),
}))

const item: SetupComposerItem = {
  sourceSetupRevisionId: 'version-1', sourceSetupName: 'Daily', sourceRevisionNumber: 1,
  artifactId: 'skill', artifactKind: 'skill', portableSource: null,
  contentDigest: 'sha256:abc', toolId: 'codex', targetName: 'review',
}
const revision = { setupId: 'daily', setupRevisionId: 'version-1', name: 'Daily', kind: 'custom' as const,
  revisionNumber: 1, itemCount: 1, createdAt: '2026-10-17T10:00:00Z', items: [item] }
function mockClient() {
  return {
    setups: vi.fn().mockResolvedValue({ setups: [{ ...revision, latestRevision: revision, projectCount: 0 }] }),
    setup: vi.fn().mockResolvedValue({ setupId: 'daily', name: 'Daily', kind: 'custom', defaultProjectId: null,
      initialSetupRevisionId: 'version-1', revisions: [revision], projects: [] }),
    setupComposer: vi.fn().mockResolvedValue({ items: [item] }),
    catalogue: vi.fn().mockResolvedValue([]),
    library: vi.fn(), createSetup: vi.fn(), publishSetupRevision: vi.fn(), createEvaluation: vi.fn(),
  }
}

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.clear(); sessionStorage.clear()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove(); vi.unstubAllGlobals()
})
async function mount() {
  const client = mockClient(); const onSignOut = vi.fn()
  await act(async () => root.render(<App client={client as unknown as ControlPlaneClient} onSignOut={onSignOut} />))
  return { client, onSignOut }
}
function visible(element: Element) { return !element.closest('[hidden],dialog:not([open])') }
function button(name: string, scope: ParentNode = container) {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(element => visible(element)
    && (element.getAttribute('aria-label') === name || element.textContent?.trim() === name))
  expect(found, `Visible button: ${name}`).toBeDefined()
  return found!
}
async function click(name: string, scope?: ParentNode) { await act(async () => button(name, scope).click()) }
function activeNavigation() { return [...container.querySelectorAll('.skills-sidebar button.active')] }

it('opens saved Setups directly while disconnected without starting a connection or local operation', async () => {
  const { client } = await mount()
  expect(client.setups).not.toHaveBeenCalled()
  await click('Setups')
  expect(client.setups).toHaveBeenCalledOnce()
  expect(container.querySelector('[data-page=setups]')?.hasAttribute('hidden')).toBe(false)
  expect(activeNavigation()).toEqual([button('Setups')])
  expect(button('Setups').getAttribute('aria-current')).toBe('page')
  expect(container.querySelectorAll('main')).toHaveLength(1)
  expect(container.querySelector('main')?.id).toBe('main-content')
  expect(container.querySelector('a[href="#main-content"]')).not.toBeNull()
  await act(async () => container.querySelector<HTMLButtonElement>('[data-page=setups] .library-row')!.click())
  expect([...container.querySelectorAll('h1')].filter(visible).map(element => element.textContent)).toEqual(['Daily'])
  expect(connection.createEnrollment).not.toHaveBeenCalled()
  expect(client.library).not.toHaveBeenCalled()
  expect(client.createEvaluation).not.toHaveBeenCalled()
})

it('preserves an unsaved Setup name and selected contents across Projects and My Skills', async () => {
  const { client } = await mount()
  await click('Setups'); await click('Create Setup')
  const editor = container.querySelector<HTMLFormElement>('.library-editor')!
  const name = editor.querySelector<HTMLInputElement>('input[required]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Release review')
    name.dispatchEvent(new Event('input', { bubbles: true }))
    editor.querySelector<HTMLInputElement>('input[type=checkbox]')!.click()
  })
  await click('Projects')
  expect(activeNavigation()).toEqual([button('Projects')])
  expect(visible(editor)).toBe(false)
  await click('My Skills')
  expect(activeNavigation()).toEqual([button('My Skills')])
  expect(visible(editor)).toBe(false)
  await click('Setups')
  expect(container.querySelector('.library-editor')).toBe(editor)
  expect(visible(editor)).toBe(true)
  expect(name.value).toBe('Release review')
  expect(editor.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(true)
  expect(client.setupComposer).toHaveBeenCalledTimes(2)
  expect(client.createSetup).not.toHaveBeenCalled()
  expect(client.publishSetupRevision).not.toHaveBeenCalled()
  expect(connection.createEnrollment).not.toHaveBeenCalled()
})

it('Open My Skills from an empty composer navigates to My Skills instead of the previous Settings view', async () => {
  const { client } = await mount()
  client.setupComposer.mockResolvedValue({ items: [] })
  await click('Settings'); await click('Setups'); await click('Create Setup')
  await click('Open My Skills')
  expect(activeNavigation()).toEqual([button('My Skills')])
  expect([...container.querySelectorAll('h1')].filter(visible).map(element => element.textContent)).toContain('Manage your skills in one place')
  expect(connection.createEnrollment).not.toHaveBeenCalled()
})

it('shows an ordered first-run path and lets users browse skills before connecting', async () => {
  const { client } = await mount()
  expect(container.querySelector('.workspace-start-steps')?.textContent).toContain('Import or install skills')
  expect(button('Set up this computer')).toBeDefined()
  await click('Browse skills')
  expect(client.catalogue).toHaveBeenCalledWith({ command: 'get_featured_skills', args: {}, expectedDigest: null })
  expect(connection.createEnrollment).not.toHaveBeenCalled()
  expect(client.library).not.toHaveBeenCalled()
})

it('keeps original library, management, settings, inventory and sign-out destinations reachable', async () => {
  const { client, onSignOut } = await mount()
  for (const name of ['Setups', 'Projects', 'Computer inventory', 'Tags', 'Tools', 'Updates', 'Settings', 'My Skills']) {
    await click(name, container.querySelector('.skills-sidebar')!)
    expect(activeNavigation(), name).toEqual([button(name, container.querySelector('.skills-sidebar')!)])
    expect(container.querySelectorAll('main')).toHaveLength(1)
  }
  const explore = container.querySelector<HTMLButtonElement>('.skills-sidebar button[aria-label="Add Skills"]')
  expect(explore).not.toBeNull()
  await act(async () => explore!.click())
  expect(client.catalogue).toHaveBeenCalledWith({ command: 'get_featured_skills', args: {}, expectedDigest: null })
  await click('Sign out')
  expect(onSignOut).toHaveBeenCalledOnce()
  expect(connection.createEnrollment).not.toHaveBeenCalled()
  expect(client.library).not.toHaveBeenCalled()
})
