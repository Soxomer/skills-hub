// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ControlPlaneClient } from './api'
import { HelperOnboarding } from './components/HelperOnboarding'
import { LibraryProvider } from './hub/LibraryProvider'
import SkillsHub from './hub/SkillsHub'
import type { ManagedSkill, OnboardingPlan } from './hub/components/skills/types'
import { useRunnerConnection } from './useRunnerConnection'
import './i18n'

vi.mock('./hub/web-update', () => ({
  getWebVersion: vi.fn().mockResolvedValue('test'), checkForWebUpdate: vi.fn().mockResolvedValue(null),
}))
vi.mock('sonner', () => ({ Toaster: () => null, toast: { error: vi.fn(), success: vi.fn() } }))

const emptyPlan = { total_tools_scanned: 1, total_skills_found: 0, groups: [] }
const libraryResponses: Record<string, unknown> = {
  get_managed_skills: [], get_tags: [], get_recent_projects: [], get_onboarding_plan: emptyPlan,
  get_central_repo_path: 'fixture-library', get_git_cache_cleanup_days: 30, get_git_cache_ttl_secs: 60,
  get_github_token: '', get_github_proxy_config: { enabled: false, port: 7890, url: '', auto_detected: false },
  get_auto_update_config: { enabled: false, last_status: null },
  get_tool_config: { disabled_builtin_tools: [], custom_tools: [] },
  get_tool_status: { tools: [], installed: [], newly_installed: [] },
  get_discovery_scan_settings: { sources: [], disabled_source_keys: [] },
  import_existing_skill: { skill_id: 'beta', central_path: 'folder-beta' },
}

function libraryClient(failFirstLibraryRead = false, discoveryResponses: (OnboardingPlan | Promise<OnboardingPlan>)[] = [], managedSkills: ManagedSkill[] = []) {
  let libraryReads = 0
  let discoveryReads = 0
  const commands = new Map<string, string>()
  return {
    library: vi.fn(async (_device: string, request: { command: string }) => {
      if (request.command === 'get_managed_skills' && ++libraryReads === 1 && failFirstLibraryRead) {
        throw new Error('Temporary workspace connection failure')
      }
      const jobId = `fixture-job-${commands.size}`
      commands.set(jobId, request.command)
      return { jobId }
    }),
    job: vi.fn(async (jobId: string) => {
      const command = commands.get(jobId)!
      if (!(command in libraryResponses)) throw new Error(`Unexpected fixture command: ${command}`)
      const value = command === 'get_managed_skills' ? managedSkills : command === 'get_onboarding_plan' && discoveryReads < discoveryResponses.length
        ? await discoveryResponses[discoveryReads++] : libraryResponses[command]
      return { result: { result: { kind: 'libraryResponse', payload: { value } } } }
    }),
    catalogue: vi.fn().mockResolvedValue([]),
  }
}

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

function visible(element: Element) { return !element.closest('[hidden],dialog:not([open])') }
function button(label: string) {
  const result = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find(element => visible(element) && element.textContent?.trim() === label)
  expect(result, `Visible button: ${label}`).toBeDefined()
  return result!
}
async function mountLibrary(client: ReturnType<typeof libraryClient>) {
  await act(async () => root.render(<LibraryProvider client={client as unknown as ControlPlaneClient} deviceId="fixture-device" connected>
    <SkillsHub onOpenWorkspace={vi.fn()} />
  </LibraryProvider>))
}

it('offers the first useful import or browse action after connecting an empty computer', async () => {
  const client = libraryClient()
  await mountLibrary(client)
  expect(container.querySelector('#workspace-ready-title')?.textContent).toBe('Add your first skills')
  expect(button('Find existing skills').disabled).toBe(false)
  expect(button('Browse skills').disabled).toBe(false)
  expect(client.library.mock.calls.every(([, request]) => request.command.startsWith('get_'))).toBe(true)

  await act(async () => button('Find existing skills').click())
  expect(container.querySelector('[role=dialog][aria-labelledby="import-skills-title"]')).not.toBeNull()
  expect(container.textContent).toContain('No existing skills were found')
  const importDialog = container.querySelector('[aria-labelledby="import-skills-title"]')!
  await act(async () => [...importDialog.querySelectorAll<HTMLButtonElement>('button')]
    .find(element => element.textContent === 'Browse skills')!.click())
  expect(client.catalogue).toHaveBeenCalledWith({ command: 'get_featured_skills', args: {}, expectedDigest: null })
  expect(container.querySelector('[aria-labelledby="import-skills-title"]')).toBeNull()
})

it('keeps a failed first library load recoverable after transient feedback disappears', async () => {
  const client = libraryClient(true)
  await mountLibrary(client)
  expect(container.querySelector('#workspace-ready-title')).toBeNull()
  expect(container.querySelector('[role=alert]')?.textContent).toContain('Your skills could not be loaded')
  expect(container.textContent).not.toContain('Loading skills on this computer')
  await act(async () => vi.advanceTimersByTimeAsync(3000))
  expect(button('Retry loading skills').disabled).toBe(false)
  expect(client.library.mock.calls.filter(([, request]) => request.command === 'get_managed_skills')).toHaveLength(1)

  await act(async () => button('Retry loading skills').click())
  expect(client.library.mock.calls.filter(([, request]) => request.command === 'get_managed_skills')).toHaveLength(2)
  expect(container.querySelector('[role=alert]')).toBeNull()
  expect(container.querySelector('#workspace-ready-title')?.textContent).toBe('Add your first skills')
})

it('scans only on request, preserves reviewed choices, and finishes importing without a redundant full scan', async () => {
  const plan: OnboardingPlan = { total_tools_scanned: 2, total_skills_found: 3, groups: [
    { name: 'alpha', has_conflict: false, variants: [
      { name: 'alpha', tool: 'codex', path: 'codex-alpha', is_link: false, link_target: null },
    ] },
    { name: 'beta', has_conflict: true, variants: [
      { name: 'beta', tool: 'codex', path: 'codex-beta', is_link: false, link_target: null },
      { name: 'beta', tool: 'claude', path: 'claude-beta', is_link: false, link_target: null },
    ] },
  ] }
  const client = libraryClient(false, [plan, plan])
  await mountLibrary(client)
  expect(client.library.mock.calls.filter(([, request]) => request.command === 'get_onboarding_plan')).toHaveLength(0)

  await act(async () => button('Find existing skills').click())
  expect(client.library.mock.calls.filter(([, request]) => request.command === 'get_onboarding_plan')).toHaveLength(1)
  const dialog = container.querySelector('[aria-labelledby="import-skills-title"]')!
  const alpha = [...dialog.querySelectorAll('.group-card')].find(group => group.querySelector('.group-select span')?.textContent === 'alpha')!
  const alphaSelected = alpha.querySelector<HTMLInputElement>('input[type=checkbox]')!
  const betaChoice = dialog.querySelectorAll<HTMLInputElement>('input[name="variant-beta"]')
  await act(async () => { alphaSelected.click(); betaChoice[1].click() })
  expect(alphaSelected.checked).toBe(false)
  expect(betaChoice[1].checked).toBe(true)

  await act(async () => vi.advanceTimersByTimeAsync(3000))
  expect(alphaSelected.checked).toBe(false)
  expect(betaChoice[0].checked).toBe(false)
  expect(betaChoice[1].checked).toBe(true)
  await act(async () => button('Import 1 selected skills').click())
  expect(client.library).toHaveBeenCalledWith('fixture-device', expect.objectContaining({ command: 'import_existing_skill', args: { sourcePath: 'claude-beta', name: 'beta' } }))
  expect(client.library.mock.calls.filter(([, request]) => request.command === 'get_onboarding_plan')).toHaveLength(1)
  expect(container.querySelector('[aria-labelledby="import-skills-title"]')).toBeNull()
  await act(async () => button('Find existing skills').click())
  expect(client.library.mock.calls.filter(([, request]) => request.command === 'get_onboarding_plan')).toHaveLength(2)
})

it('requires an explicit retry after connection preparation fails and then offers the new link', async () => {
  const enrollment = { enrollmentId: 'fixture-enrollment', code: 'abcdefghijklmnop',
    command: 'ahm connect abcdefghijklmnop --server https://example.com', expiresAt: '2099-01-01T00:00:00Z' }
  const client = {
    runners: vi.fn().mockResolvedValue([]),
    createRunnerEnrollment: vi.fn().mockRejectedValueOnce(new Error('Temporary connection failure')).mockResolvedValue(enrollment),
    runnerEnrollment: vi.fn().mockResolvedValue({ enrollmentId: enrollment.enrollmentId, state: 'waiting', deviceId: null, expiresAt: enrollment.expiresAt }),
  }
  function Fixture() {
    const connection = useRunnerConnection(client as unknown as ControlPlaneClient)
    return <HelperOnboarding connection={connection} connected={false} initialInstalled onFinish={vi.fn()} />
  }
  await act(async () => root.render(<Fixture />))
  expect(container.querySelector('[role=alert]')?.textContent).toContain('Could not confirm the connection')
  expect(client.createRunnerEnrollment).toHaveBeenCalledOnce()
  await act(async () => vi.advanceTimersByTimeAsync(3000))
  expect(client.createRunnerEnrollment).toHaveBeenCalledOnce()
  await act(async () => container.querySelector<HTMLButtonElement>('button.primary-button')!.click())
  expect(client.createRunnerEnrollment).toHaveBeenCalledTimes(2)
  expect(container.querySelector('[role=alert]')).toBeNull()
  expect(container.querySelector('a[href^="ahm://connect"]')?.getAttribute('href')).toContain('example.com')
})

it('keeps scanning available in a populated library and reads fresh results after closing each review', async () => {
  const managed: ManagedSkill = { id: 'managed', name: 'managed', source_type: 'local', central_path: 'folder-managed', created_at: 1, updated_at: 1, enabled: true, status: 'ok', tags: [], targets: [] }
  const plan = (name: string): OnboardingPlan => ({ total_tools_scanned: 1, total_skills_found: 1,
    groups: [{ name, has_conflict: false, variants: [{ tool: 'codex', name, path: `folder-${name}`, is_link: false }] }] })
  let finishScan!: (value: OnboardingPlan) => void
  const firstScan = new Promise<OnboardingPlan>(resolve => { finishScan = resolve })
  const client = libraryClient(false, [firstScan, plan('newly-added'), emptyPlan], [managed])
  const scans = () => client.library.mock.calls.filter(([, request]) => request.command === 'get_onboarding_plan')
  const closeReview = async () => act(async () => container.querySelector<HTMLButtonElement>('[aria-labelledby="import-skills-title"] button[aria-label="Close"]')!.click())
  await mountLibrary(client)
  expect(scans()).toHaveLength(0)
  expect(button('Scan for existing skills').disabled).toBe(false)
  await act(async () => button('Scan for existing skills').click())
  expect(scans()).toHaveLength(1)
  expect(button('Scan for existing skills').disabled).toBe(true)
  expect(container.textContent).toContain('Scanning for existing skills...')
  expect(container.textContent).not.toContain('Installing Skills...')
  await act(async () => finishScan(plan('first-found')))
  expect(container.querySelector('[aria-labelledby="import-skills-title"]')?.textContent).toContain('first-found')
  await closeReview()
  await act(async () => button('Scan for existing skills').click())
  expect(scans()).toHaveLength(2)
  const review = container.querySelector('[aria-labelledby="import-skills-title"]')!
  expect(review.textContent).toContain('newly-added')
  expect(review.textContent).not.toContain('first-found')
  await closeReview()
  await act(async () => button('Scan for existing skills').click())
  expect(scans()).toHaveLength(3)
  expect(container.querySelector('[aria-labelledby="import-skills-title"]')?.textContent).toContain('No existing skills were found')
  await closeReview()
  expect(button('Scan for existing skills').disabled).toBe(false)
  expect(client.library.mock.calls.some(([, request]) => request.command === 'import_existing_skill')).toBe(false)
})
