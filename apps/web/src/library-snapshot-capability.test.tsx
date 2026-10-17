// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ControlPlaneClient } from './api'
import { LibraryProvider } from './hub/LibraryProvider'
import { useLibrary } from './hub/library-context'
import './i18n'

const snapshot = { artifactId: 'review', name: 'review', contentDigest: `sha256:${'a'.repeat(64)}`,
  portableSource: null, supportedTools: ['codex'], files: [{ path: 'SKILL.md', size: 10 }] }
function Probe() {
  const library = useLibrary()
  const [message, setMessage] = useState('')
  const run = async (operation: () => Promise<unknown>) => {
    try { await operation(); setMessage('complete') }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
  }
  return <><span>{message}</span>
    <button onClick={() => void run(() => library.previewSetupSkill('review'))}>Preview</button>
    <button onClick={() => void run(() => library.snapshotSetupSkill('review', snapshot.contentDigest))}>Snapshot</button>
    <button onClick={() => void run(() => library.invokeLibrary('get_managed_skills'))}>List skills</button>
  </>
}
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
async function mount(support?: boolean) {
  const client = { library: vi.fn().mockResolvedValue({ jobId: 'job' }),
    job: vi.fn().mockResolvedValue({ result: { result: { kind: 'libraryResponse', payload: { value: snapshot } } } }) }
  await act(async () => root.render(<LibraryProvider client={client as unknown as ControlPlaneClient}
    deviceId="device" connected setupSnapshotsSupported={support}><Probe /></LibraryProvider>))
  return client
}
async function click(label: string) {
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === label)!.click())
}
it.each([undefined, false])('rejects snapshot calls locally when capability is %s but permits ordinary library work', async support => {
  const client = await mount(support)
  for (const action of ['Preview', 'Snapshot']) {
    await click(action)
    expect(container.textContent).toContain('does not support saving skills to Setups')
    expect(client.library).not.toHaveBeenCalled()
  }
  await click('List skills')
  expect(client.library).toHaveBeenCalledExactlyOnceWith('device', { command: 'get_managed_skills', args: {}, expectedDigest: null })
  expect(container.textContent).toContain('complete')
})
it('sends both snapshot commands only with explicit support and preserves the reviewed digest', async () => {
  const client = await mount(true)
  await click('Preview'); await click('Snapshot')
  expect(client.library.mock.calls).toEqual([
    ['device', { command: 'preview_setup_skill', args: { skillId: 'review' }, expectedDigest: null }],
    ['device', { command: 'snapshot_setup_skill', args: { skillId: 'review' }, expectedDigest: snapshot.contentDigest }],
  ])
  expect(container.textContent).toContain('complete')
})
