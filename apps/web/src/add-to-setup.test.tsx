// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { LibrarySetupSnapshot, SetupDetail } from '@ahm/contracts'
import { ControlPlaneApiError, type ControlPlaneClient } from './api'
import { LibraryContext } from './hub/library-context'
import { AddToSetupDialog } from './hub/components/skills/AddToSetupDialog'
import type { ManagedSkill } from './hub/components/skills/types'
import './i18n'

const snapshot: LibrarySetupSnapshot = { artifactId: 'library-review', name: 'review', contentDigest: 'sha256:'+'a'.repeat(64), portableSource: null, supportedTools: ['codex','claude_code'], files: [{ path:'SKILL.md', size:10 }, { path:'support.txt', size:20 }] }
const revision = { setupId:'daily', setupRevisionId:'v1', name:'Daily', kind:'custom' as const, revisionNumber:1, itemCount:1, createdAt:'2026-10-11T00:00:00Z' }
const detail: SetupDetail = { setupId:'daily', name:'Daily', kind:'custom', defaultProjectId:null, initialSetupRevisionId:'v1', projects:[], revisions:[{ ...revision, items:[{ sourceSetupRevisionId:'v1', sourceSetupName:'Daily', sourceRevisionNumber:1, artifactId:'old', artifactKind:'skill', portableSource:null, contentDigest:snapshot.contentDigest, toolId:'codex', targetName:'review' }] }] }
const skill: ManagedSkill = { id:'review', name:'review', central_path:'folder-fixture/review', source_type:'local', created_at:1, updated_at:1, enabled:true, status:'ok', tags:[], targets:[] }
let root: Root
let container: HTMLDivElement
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container=document.createElement('div'); document.body.append(container); root=createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
function fixture() {
  const client = { setups:vi.fn().mockResolvedValue({setups:[{setupId:'daily',name:'Daily',latestRevision:revision}]}), setup:vi.fn().mockResolvedValue(detail), addLibrarySkillToSetup:vi.fn().mockResolvedValue({...revision,setupRevisionId:'v2',revisionNumber:2}) }
  return { client, context:{client:client as unknown as ControlPlaneClient, deviceId:'device', runnerConnected:true, previewSetupSkill:vi.fn().mockResolvedValue(snapshot), snapshotSetupSkill:vi.fn().mockResolvedValue('snapshot-job'), invokeLibrary:vi.fn(), pickDirectory:vi.fn(), onOpenSetup:vi.fn()}, close:vi.fn() }
}
async function mount(f=fixture()) { await act(async () => root.render(<LibraryContext.Provider value={f.context}><AddToSetupDialog skill={skill} tools={[{id:'codex',label:'Codex'},{id:'claude_code',label:'Claude Code'}]} onClose={f.close} /></LibraryContext.Provider>)); return f }
async function click(label:string) { const button=[...container.querySelectorAll('button')].find(b=>b.textContent===label); expect(button).toBeDefined(); await act(async()=>button!.click()) }
async function tick(index:number) { await act(async()=>container.querySelectorAll<HTMLInputElement>('input[type=checkbox]')[index]!.click()) }
async function mode(value:'existing'|'new') { await act(async()=>container.querySelector<HTMLInputElement>(`input[type=radio][value=${value}]`)!.click()) }
async function chooseDaily() { await mode('existing'); const select=container.querySelector('select')!; await act(async()=>{ select.value='daily'; select.dispatchEvent(new Event('change',{bubbles:true})) }) }
async function input(index:number,value:string) { const element=container.querySelectorAll<HTMLInputElement>('input:not([type=checkbox]):not([type=radio])')[index]!; await act(async()=>{ Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(element,value); element.dispatchEvent(new Event('input',{bubbles:true})) }) }

it('previews without sharing content, requires target and sharing consent, and cancellation uploads nothing', async()=>{
  const f=await mount()
  expect(f.context.previewSetupSkill).toHaveBeenCalledWith('review')
  expect(container.textContent).toContain('support.txt')
  expect(container.querySelector<HTMLButtonElement>('.btn-primary')!.disabled).toBe(true)
  expect(f.context.snapshotSetupSkill).not.toHaveBeenCalled()
  await click('Cancel')
  expect(f.close).toHaveBeenCalledOnce()
  expect(f.client.addLibrarySkillToSetup).not.toHaveBeenCalled()
})
it('publishes the exact reviewed digest to a new Setup and reports save versus Apply', async()=>{
  const f=await mount(); await mode('new'); await input(0,'Focused'); await tick(0); await tick(2)
  await click('Create Setup')
  expect(f.context.snapshotSetupSkill).toHaveBeenCalledWith('review',snapshot.contentDigest)
  expect(f.client.addLibrarySkillToSetup).toHaveBeenCalledWith({snapshotJobId:'snapshot-job',contentDigest:snapshot.contentDigest,destination:{name:'Focused'},targets:[{toolId:'codex',targetName:'review'}]})
  expect(container.textContent).toContain('No project assignment or local synchronization changed')
})
it('keeps existing items, prevents a collision, and publishes against the reviewed destination version', async()=>{
  const f=await mount(); await chooseDaily(); await tick(0)
  expect(container.textContent).toContain('already exist in the Setup')
  expect(container.querySelector<HTMLButtonElement>('.btn-primary')!.disabled).toBe(true)
  await tick(0); await tick(1); await tick(2); await click('Add to Setup')
  expect(f.client.addLibrarySkillToSetup).toHaveBeenCalledWith(expect.objectContaining({destination:{setupId:'daily',expectedRevisionNumber:1},targets:[{toolId:'claude_code',targetName:'review'}]}))
})
it('opens the exact saved revision only after the user chooses the saved Setup handoff', async()=>{
  const f=await mount(); await tick(1); await tick(2); await click('Add to Setup')
  expect(f.context.onOpenSetup).not.toHaveBeenCalled()
  await click('Open saved Setup')
  expect(f.close).toHaveBeenCalledOnce()
  expect(f.context.onOpenSetup).toHaveBeenCalledWith({setupId:'daily',setupRevisionId:'v2'})
  expect(f.close.mock.invocationCallOrder[0]).toBeLessThan(f.context.onOpenSetup.mock.invocationCallOrder[0])
  expect(f.client.addLibrarySkillToSetup).toHaveBeenCalledOnce()
})
it('preserves the draft and snapshot job after a failed response so retry does not snapshot twice', async()=>{
  const f=fixture(); f.client.addLibrarySkillToSetup.mockRejectedValueOnce(new Error('offline'))
  await mount(f); await mode('new'); await input(0,'Focused'); await tick(0); await tick(2); await click('Create Setup')
  expect(container.querySelector('[role=alert]')!.textContent).toContain('Publication did not finish')
  await click('Create Setup')
  expect(f.context.snapshotSetupSkill).toHaveBeenCalledOnce()
  expect(f.client.addLibrarySkillToSetup).toHaveBeenCalledTimes(2)
})
it('explains stale revisions and prevents publication on a different computer', async()=>{
  const f=fixture(); f.client.addLibrarySkillToSetup.mockRejectedValue(new ControlPlaneApiError(409,'stale','setupRevisionConflict'))
  await mount(f); await chooseDaily(); await tick(1); await tick(2); await click('Add to Setup')
  expect(container.querySelector('[role=alert]')!.textContent).toContain('newer Setup version')
  f.context.deviceId='other-device'; await mount(f)
  expect(container.textContent).toContain('original computer')
  expect(container.querySelector<HTMLButtonElement>('.btn-primary')!.disabled).toBe(true)
})
it('separates existing and new destinations without publishing on mode changes', async()=>{
  const f=await mount()
  expect(container.querySelector<HTMLInputElement>('input[value=existing]')!.checked).toBe(true)
  expect([...container.querySelectorAll('option')].map(o=>o.textContent)).toEqual(['Daily · Version 1'])
  expect(container.textContent).toContain('Keep all 1 existing items')
  await tick(1); await tick(2)
  expect(container.querySelector<HTMLButtonElement>('.btn-primary')!.disabled).toBe(false)
  await mode('new')
  expect(container.querySelector('select')).toBeNull()
  expect(container.textContent).toContain('Created only when you confirm below')
  await input(0,'Focused')
  expect(container.querySelector<HTMLButtonElement>('.btn-primary')!.textContent).toBe('Create Setup')
  expect(container.querySelector<HTMLButtonElement>('.btn-primary')!.disabled).toBe(true)
  await tick(2); await input(0,'Other')
  expect(container.querySelectorAll<HTMLInputElement>('input[type=checkbox]')[2]!.checked).toBe(false)
  await mode('existing')
  expect(container.querySelector('select')!.value).toBe('daily')
  expect(container.querySelector<HTMLButtonElement>('.btn-primary')!.textContent).toBe('Add to Setup')
  expect(f.context.snapshotSetupSkill).not.toHaveBeenCalled()
  expect(f.client.addLibrarySkillToSetup).not.toHaveBeenCalled()
})
it('starts with New Setup when the library is empty and explains the empty existing choice', async()=>{
  const f=fixture(); f.client.setups.mockResolvedValue({setups:[]})
  await mount(f)
  expect(container.querySelector<HTMLInputElement>('input[value=new]')!.checked).toBe(true)
  expect(f.client.setup).not.toHaveBeenCalled()
  await mode('existing')
  expect(container.textContent).toContain('No saved Setups yet')
  expect(container.querySelector('select')).toBeNull()
  expect(container.querySelector<HTMLButtonElement>('.btn-primary')!.disabled).toBe(true)
})
it('refreshes an existing destination after a stale-version error without changing destination mode', async()=>{
  const f=fixture(); f.client.addLibrarySkillToSetup.mockRejectedValueOnce(new ControlPlaneApiError(409,'stale','setupRevisionConflict'))
  await mount(f); await tick(1); await tick(2); await click('Add to Setup')
  f.client.setup.mockResolvedValue({...detail,revisions:[{...detail.revisions[0]!,revisionNumber:2}]})
  await click('Review again')
  expect(container.querySelector<HTMLInputElement>('input[value=existing]')!.checked).toBe(true)
  expect(container.querySelectorAll<HTMLInputElement>('input[type=checkbox]')[2]!.checked).toBe(false)
  await tick(2); await click('Add to Setup')
  expect(f.client.addLibrarySkillToSetup).toHaveBeenLastCalledWith(expect.objectContaining({destination:{setupId:'daily',expectedRevisionNumber:2}}))
})
