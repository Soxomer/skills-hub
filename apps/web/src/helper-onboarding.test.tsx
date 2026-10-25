// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HelperOnboarding } from './components/HelperOnboarding'
import { useSkillInstallIntent } from './hub/useSkillInstallIntent'
import type { useRunnerConnection } from './useRunnerConnection'
import './i18n'

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }))
  sessionStorage.clear()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function connection(overrides: Partial<ReturnType<typeof useRunnerConnection>> = {}): ReturnType<typeof useRunnerConnection> {
  return { enrollment: null, status: null, runner: null, creating: false, error: null, createEnrollment: vi.fn(), refresh: vi.fn(), reset: vi.fn(), availableRunners: [], loadingRunners: false, runnersError: false, selecting: false, refreshRunners: vi.fn(), selectRunner: vi.fn(), ...overrides }
}
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(value => value.textContent === label)
  expect(button, label).toBeDefined()
  await act(async () => button!.click())
}

it('guides install then connect, keeps codes out of the main flow, and waits for worker confirmation', async () => {
  const value = connection()
  const finish = vi.fn()
  await act(async () => root.render(<HelperOnboarding connection={value} connected={false} onFinish={finish} />))
  expect(container.querySelectorAll('option')).toHaveLength(4)
  expect(value.createEnrollment).not.toHaveBeenCalled()
  await click('I have installed the helper')
  expect(value.createEnrollment).toHaveBeenCalledOnce()
  const enrolled = connection({ enrollment: { enrollmentId: 'fixture', code: 'abcdefghijklmnop', command: 'ahm connect abcdefghijklmnop --server https://example.com', expiresAt: '2099-01-01T00:00:00Z' } })
  await act(async () => root.render(<HelperOnboarding connection={enrolled} connected={false} onFinish={finish} />))
  expect(container.querySelector('a.primary-button')?.getAttribute('href')).toContain('ahm://connect?')
  expect(finish).not.toHaveBeenCalled()
  expect(container.querySelector('details')?.open).toBe(false)
  await act(async () => root.render(<HelperOnboarding connection={enrolled} connected onFinish={finish} />))
  await click('Continue')
  expect(finish).toHaveBeenCalledWith(true)
})

it('recovers from expired enrollment without opening the stale link', async () => {
  const value = connection({ enrollment: { enrollmentId: 'old', code: 'abcdefghijklmnop', command: 'ahm connect abcdefghijklmnop --server https://example.com', expiresAt: '2020-01-01T00:00:00Z' } })
  await act(async () => root.render(<HelperOnboarding connection={value} connected={false} onFinish={vi.fn()} />))
  expect(container.querySelector('a[href^="ahm://connect"]')).toBeNull()
  expect(container.textContent).toContain('The connection link expired')
  await act(async () => container.querySelector<HTMLButtonElement>('button.primary-button')!.click())
  expect(value.createEnrollment).toHaveBeenCalledOnce()
})

it('skips installation when opened from the installed desktop app and prepares once', async () => {
  const value = connection()
  await act(async () => root.render(<HelperOnboarding connection={value} connected={false} initialInstalled onFinish={vi.fn()} />))
  expect(container.textContent).toContain('Connect to this workspace')
  expect(container.textContent).not.toContain('I have installed the helper')
  expect(value.createEnrollment).toHaveBeenCalledOnce()
  await act(async () => root.render(<HelperOnboarding connection={value} connected={false} initialInstalled onFinish={vi.fn()} />))
  expect(value.createEnrollment).toHaveBeenCalledOnce()
})

it('explains an invalid server address instead of generating links that never open', async () => {
  const value = connection({ enrollment: { enrollmentId: 'bad', code: 'abcdefghijklmnop', command: 'ahm connect abcdefghijklmnop --server http://remote.example.com', expiresAt: '2099-01-01T00:00:00Z' } })
  await act(async () => root.render(<HelperOnboarding connection={value} connected={false} onFinish={vi.fn()} />))
  expect(container.querySelector('[role=alert]')?.textContent).toContain('unsupported connection address')
  expect(container.querySelector('a[href^="ahm://connect"]')).toBeNull()
  expect(value.createEnrollment).not.toHaveBeenCalled()
  await click('Try the updated workspace address')
  expect(value.createEnrollment).toHaveBeenCalledOnce()
})

it('prepares a local connection without requiring HTTPS or a tunnel', async () => {
  const value = connection({ enrollment: { enrollmentId: 'local', code: 'abcdefghijklmnop', command: 'ahm connect abcdefghijklmnop --server http://127.0.0.1:8787', expiresAt: '2099-01-01T00:00:00Z' } })
  await act(async () => root.render(<HelperOnboarding connection={value} connected={false} onFinish={vi.fn()} />))
  expect(container.querySelector('a[href^="ahm://connect"]')?.getAttribute('href')).toContain('127.0.0.1')
  expect(container.textContent).toContain('No public tunnel is needed')
})

it('offers the matching local installer instead of the older published helper', async () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
  vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ windows: '/__ahm/helper-installers/windows' }) } as Response)
  await act(async () => root.render(<HelperOnboarding connection={connection()} connected={false} onFinish={vi.fn()} />))
  expect(container.querySelector<HTMLSelectElement>('#helper-platform')?.value).toBe('windows')
  expect(container.querySelector('a.primary-button')?.getAttribute('href')).toBe('/__ahm/helper-installers/windows')
  expect(container.textContent).not.toContain('not ready yet')
})

it('does not offer an older published installer when the local build is unavailable', async () => {
  await act(async () => root.render(<HelperOnboarding connection={connection()} connected={false} onFinish={vi.fn()} />))
  expect(container.querySelector('a.primary-button')).toBeNull()
  expect(container.textContent).toContain('installer for this local workspace is not ready')
})

it('cancelling keeps browsing available and never confirms a connection', async () => {
  const finish = vi.fn()
  await act(async () => root.render(<HelperOnboarding connection={connection()} connected={false} onFinish={finish} />))
  await click('Keep browsing')
  expect(finish).toHaveBeenCalledWith(false)
})

it('retains the exact selected source across setup and resumes using the connected callback', async () => {
  let resolveConnection: (value: boolean) => void = () => {}
  const request = vi.fn(() => new Promise<boolean>(resolve => { resolveConnection = resolve }))
  const oldInstall = vi.fn(), newInstall = vi.fn()
  function Fixture({ connected, install }: { connected: boolean; install: (url: string, name?: string) => void }) {
    const intent = useSkillInstallIntent(connected, request, install, true)
    return <><button onClick={() => void intent.install('https://github.com/example/skills/tree/abc123/review', 'Review')}>Install</button><span>{intent.pending?.skillName}</span></>
  }
  await act(async () => root.render(<Fixture connected={false} install={oldInstall} />))
  await click('Install')
  expect(oldInstall).not.toHaveBeenCalled()
  expect(sessionStorage.getItem('ahm.pending-skill-install')).toContain('abc123/review')
  await act(async () => root.render(<Fixture connected install={newInstall} />))
  await act(async () => resolveConnection(true))
  expect(oldInstall).not.toHaveBeenCalled()
  expect(newInstall).toHaveBeenCalledExactlyOnceWith('https://github.com/example/skills/tree/abc123/review', 'Review')
  expect(sessionStorage.getItem('ahm.pending-skill-install')).toBeNull()
})

it('waits for tool readiness after connection and resumes once with the latest tool callback', async () => {
  let resolveConnection: (value: boolean) => void = () => {}
  const request = vi.fn(() => new Promise<boolean>(resolve => { resolveConnection = resolve }))
  const earlyInstall = vi.fn(), readyInstall = vi.fn()
  function Fixture({ connected, ready, install }: { connected: boolean; ready: boolean; install: (url: string, name?: string) => void }) {
    const intent = useSkillInstallIntent(connected, request, install, ready)
    return <><button onClick={() => void intent.install('https://github.com/example/skills/tree/pinned/review', 'Review')}>Install</button><span>{intent.pending?.skillName}</span><button onClick={intent.dismiss}>Cancel</button></>
  }
  await act(async () => root.render(<Fixture connected={false} ready={false} install={earlyInstall} />))
  await click('Install')
  await act(async () => root.render(<Fixture connected ready={false} install={earlyInstall} />))
  await act(async () => resolveConnection(true))
  expect(earlyInstall).not.toHaveBeenCalled()
  expect(sessionStorage.getItem('ahm.pending-skill-install')).toContain('pinned/review')
  await act(async () => root.render(<Fixture connected ready install={readyInstall} />))
  expect(readyInstall).toHaveBeenCalledExactlyOnceWith('https://github.com/example/skills/tree/pinned/review', 'Review')
  expect(sessionStorage.getItem('ahm.pending-skill-install')).toBeNull()
  await act(async () => root.render(<Fixture connected ready install={readyInstall} />))
  expect(readyInstall).toHaveBeenCalledOnce()
})

it('cancels a confirmed selection while detecting tools and does not auto-run a restored selection', async () => {
  const install = vi.fn()
  function Fixture({ ready }: { ready: boolean }) {
    const intent = useSkillInstallIntent(true, undefined, install, ready)
    return <><button onClick={() => void intent.install('https://github.com/example/skills', 'Review')}>Install</button><button onClick={intent.dismiss}>Cancel</button><span>{intent.pending?.skillName}</span></>
  }
  await act(async () => root.render(<Fixture ready={false} />))
  await click('Install')
  await click('Cancel')
  await act(async () => root.render(<Fixture ready />))
  expect(install).not.toHaveBeenCalled()
  await act(async () => root.unmount())
  sessionStorage.setItem('ahm.pending-skill-install', JSON.stringify({ sourceUrl: 'https://github.com/example/skills', skillName: 'Restored' }))
  root = createRoot(container)
  await act(async () => root.render(<Fixture ready />))
  expect(container.textContent).toContain('Restored')
  expect(install).not.toHaveBeenCalled()
})
