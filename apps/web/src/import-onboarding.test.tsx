// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useTranslation } from 'react-i18next'
import ImportModal from './hub/components/skills/modals/ImportModal'
import type { OnboardingPlan } from './hub/components/skills/types'
import './i18n'

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

function Fixture({ plan, browse = vi.fn() }: { plan: OnboardingPlan; browse?: () => void }) {
  const { t } = useTranslation('hub')
  return <ImportModal open loading={false} plan={plan} selected={{ alpha: true, beta: true }} variantChoice={{}}
    onRequestClose={vi.fn()} onToggleGroup={vi.fn()} onSelectVariant={vi.fn()} onImport={vi.fn()} onBrowseSkills={browse} t={t} />
}

it('keeps hidden selections importable when discovery results are filtered', async () => {
  const plan = { total_tools_scanned: 1, total_skills_found: 2, groups: [
    { name: 'alpha', has_conflict: false, variants: [] }, { name: 'beta', has_conflict: false, variants: [] },
  ] }
  await act(async () => root.render(<Fixture plan={plan} />))
  const search = container.querySelector<HTMLInputElement>('.import-search input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'missing')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(container.textContent).toContain('No matching discovered skills found')
  const confirm = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Import 2 selected skills'))!
  expect(confirm.disabled).toBe(false)
})

it('offers browsing when there are no skills to import, without an enabled empty import', async () => {
  const browse = vi.fn()
  await act(async () => root.render(<Fixture plan={{ total_tools_scanned: 1, total_skills_found: 0, groups: [] }} browse={browse} />))
  expect(container.textContent).toContain('No existing skills were found')
  expect(container.querySelector('[role=dialog]')?.getAttribute('aria-labelledby')).toBe('import-skills-title')
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Browse skills')!.click())
  expect(browse).toHaveBeenCalledOnce()
})
