// @vitest-environment happy-dom
import type { RunnerStatusResponse } from '@ahm/contracts'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SkillLibrary } from './components/SkillLibrary'
import './i18n'

let root: Root
let container: HTMLDivElement
const runner: RunnerStatusResponse = {
  deviceId: 'device', label: 'Laptop', status: 'active', enrolledAt: '2026-09-09T12:00:00Z', lastSeenAt: null, capabilities: null, projectInstances: [],
  skillLibrary: { reportedAt: '2026-09-09T12:00:00Z', skills: [
    { id: 'a', name: 'Review', sourceType: 'git', enabled: true, tags: ['Quality'], targets: [{ tool: 'codex', scope: 'global' }] },
    { id: 'b', name: 'Tests', sourceType: 'local', enabled: false, tags: [], targets: [] },
  ] },
}
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
async function mount(value: RunnerStatusResponse | null = runner, online = true) {
  await act(async () => root.render(<SkillLibrary runner={value} online={online} error={false} onRefresh={vi.fn()} onProjects={vi.fn()} />))
}
it('shows real inventory separately from Setups and labels offline snapshots', async () => {
  await mount(runner, false)
  expect(container.textContent).toContain('Runner offline')
  expect(container.textContent).toContain('Review')
  expect(container.textContent).toContain('codex (Global)')
  expect(container.textContent).toContain('Read-only library report')
})
it('filters by enabled state and tag without mutating the report', async () => {
  await mount()
  const selects = container.querySelectorAll('select')
  await act(async () => { selects[1].value = 'disabled'; selects[1].dispatchEvent(new Event('change', { bubbles: true })) })
  expect(container.querySelector('tbody')?.textContent).toContain('Tests')
  expect(container.querySelector('tbody')?.textContent).not.toContain('Review')
  await act(async () => { selects[0].value = 'Quality'; selects[0].dispatchEvent(new Event('change', { bubbles: true })) })
  expect(container.textContent).toContain('No skills match')
  const clear = [...container.querySelectorAll('button')].find(button => button.textContent === 'Clear filters')!
  await act(async () => clear.click())
  expect(container.querySelectorAll('tbody tr')).toHaveLength(2)
  expect(runner.skillLibrary?.skills).toHaveLength(2)
})
it('distinguishes not reported, empty, and revoked instead of showing stale content', async () => {
  await mount({ ...runner, skillLibrary: null })
  expect(container.textContent).toContain('No library report yet')
  await mount({ ...runner, skillLibrary: { reportedAt: '2026-09-09T12:00:00Z', skills: [] } })
  expect(container.textContent).toContain('No managed skills on this runner')
  await mount({ ...runner, status: 'revoked' })
  expect(container.textContent).toContain('Connect a runner')
  expect(container.querySelector('table')).toBeNull()
})
